import { Task, ContactWindow, Reservation, WorkloadFeatures } from './types';

// Helper: Calculate percentile
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  const vBase = sorted[base] || 0;
  if (base + 1 < sorted.length) {
    const vNext = sorted[base + 1] || 0;
    return vBase + rest * (vNext - vBase);
  } else {
    return vBase;
  }
}

interface Interval {
  start: number;
  end: number;
}

export function calculateFeatures(
  tasks: Task[],
  windows: ContactWindow[],
  reservations: Reservation[],
  referenceTime: Date
): WorkloadFeatures {
  const taskCount = tasks.length;

  if (taskCount === 0) {
    return {
      taskCount: 0,
      totalTaskDemandSeconds: 0,
      usableCapacitySeconds: 0,
      loadPressure: 0,
      medianDeadlinePressure: 0,
      p10DeadlinePressure: 0,
      tightTaskFraction: 0,
      highPriorityFraction: 0,
      meanGapSeconds: 0,
      p10GapSeconds: 0,
      largestGapSeconds: 0,
      fragmentationPressure: 0,
    };
  }

  const totalTaskDemandSeconds = tasks.reduce((sum, t) => sum + Math.max(0, t.duration_ms / 1000), 0);
  
  // High Priority
  const highPriorityCount = tasks.filter(t => t.priority >= 8).length;
  const highPriorityFraction = highPriorityCount / taskCount;

  // Deadline Pressure
  const refTimeMs = referenceTime.getTime();
  const dValues: number[] = [];
  let tightCount = 0;

  for (const t of tasks) {
    const deadlineMs = new Date(t.deadline).getTime();
    const durationMs = t.duration_ms;
    
    // Fallback for invalid durations
    if (durationMs <= 0) {
      dValues.push(0);
      tightCount++; // definitely tight if duration <= 0
      continue;
    }

    const d = (deadlineMs - refTimeMs) / durationMs;
    dValues.push(d);
    if (d < 2) tightCount++;
  }

  const medianDeadlinePressure = percentile(dValues, 0.5);
  const p10DeadlinePressure = percentile(dValues, 0.1);
  const tightTaskFraction = tightCount / taskCount;

  // Capacity & Gaps (Per Station)
  const windowsByStation = new Map<string, ContactWindow[]>();
  for (const w of windows) {
    if (!windowsByStation.has(w.ground_station_id)) {
      windowsByStation.set(w.ground_station_id, []);
    }
    windowsByStation.get(w.ground_station_id)!.push(w);
  }

  const reservationsByStation = new Map<string, Reservation[]>();
  for (const r of reservations) {
    if (!reservationsByStation.has(r.ground_station_id)) {
      reservationsByStation.set(r.ground_station_id, []);
    }
    reservationsByStation.get(r.ground_station_id)!.push(r);
  }

  let totalUsableCapacitySeconds = 0;
  const allGapsMs: number[] = [];

  for (const [stationId, stationWindows] of windowsByStation.entries()) {
    // 1. Union the overlapping contact windows for this station
    const windowIntervals: Interval[] = stationWindows.map(w => ({
      start: new Date(w.aos).getTime(),
      end: new Date(w.los).getTime(),
    }));
    
    windowIntervals.sort((a, b) => a.start - b.start);
    const mergedWindows: Interval[] = [];
    if (windowIntervals.length > 0) {
      let current = windowIntervals[0]!;
      for (let i = 1; i < windowIntervals.length; i++) {
        const next = windowIntervals[i]!;
        if (next.start <= current.end) {
          current.end = Math.max(current.end, next.end);
        } else {
          mergedWindows.push(current);
          current = next;
        }
      }
      mergedWindows.push(current);
    }

    // 2. Subtract reservations
    const stRes = reservationsByStation.get(stationId) || [];
    const resIntervals: Interval[] = stRes.map(r => {
      // Handle both camelCase from Drizzle and snake_case for flexibility
      const start = r.allocatedStart || r.allocated_start || r.aos;
      const end = r.allocatedEnd || r.allocated_end || r.los;
      return {
        start: start ? new Date(start as string | Date).getTime() : 0,
        end: end ? new Date(end as string | Date).getTime() : 0,
      };
    }).filter(r => r.start > 0 && r.end > 0);
    resIntervals.sort((a, b) => a.start - b.start);

    // Compute gaps
    for (const mw of mergedWindows) {
      let currentStart = mw.start;
      const mwEnd = mw.end;

      for (const res of resIntervals) {
        // Skip reservations outside this merged window
        if (res.end <= currentStart || res.start >= mwEnd) {
          continue;
        }

        // Gap before reservation
        if (res.start > currentStart) {
          allGapsMs.push(res.start - currentStart);
        }
        
        // Advance current start
        currentStart = Math.max(currentStart, res.end);
      }

      // Gap after the last reservation in this window
      if (currentStart < mwEnd) {
        allGapsMs.push(mwEnd - currentStart);
      }
    }
  }

  totalUsableCapacitySeconds = allGapsMs.reduce((sum, gapMs) => sum + gapMs / 1000, 0);

  // Load Pressure
  let loadPressure = 0;
  if (totalUsableCapacitySeconds === 0) {
    loadPressure = totalTaskDemandSeconds > 0 ? 1.0 : 0.0;
  } else {
    loadPressure = totalTaskDemandSeconds / totalUsableCapacitySeconds;
  }

  // Fragmentation
  let meanGapSeconds = 0;
  let p10GapSeconds = 0;
  let largestGapSeconds = 0;
  let fragmentationPressure = 0;

  if (allGapsMs.length > 0) {
    const gapSeconds = allGapsMs.map(ms => ms / 1000);
    meanGapSeconds = gapSeconds.reduce((a, b) => a + b, 0) / gapSeconds.length;
    p10GapSeconds = percentile(gapSeconds, 0.1);
    largestGapSeconds = Math.max(...gapSeconds);

    // Median task duration
    const taskDurations = tasks.map(t => t.duration_ms / 1000);
    const medianTaskDuration = percentile(taskDurations, 0.5);

    const tooSmallCount = gapSeconds.filter(g => g < medianTaskDuration).length;
    fragmentationPressure = tooSmallCount / gapSeconds.length;
  }

  return {
    taskCount,
    totalTaskDemandSeconds,
    usableCapacitySeconds: totalUsableCapacitySeconds,
    loadPressure,
    medianDeadlinePressure,
    p10DeadlinePressure,
    tightTaskFraction,
    highPriorityFraction,
    meanGapSeconds,
    p10GapSeconds,
    largestGapSeconds,
    fragmentationPressure,
  };
}
