import { MetricResults, LabTaskOutcome } from "./types";

export interface LabTask {
  id: string;
  createdAt: Date;
  priority: number;
}

export interface LabReservation {
  missionTaskId: string;
  contactWindowId: string;
  groundStationId: string;
  allocatedStart: Date;
  allocatedEnd: Date;
}

export interface LabContactWindow {
  id: string;
  groundStationId: string;
  aos: Date;
  los: Date;
  durationSeconds: number;
}

export function calculateMetrics(
  tasks: LabTask[],
  reservations: LabReservation[],
  windows: LabContactWindow[],
  outcomes: LabTaskOutcome[]
): MetricResults {
  const totalTasks = tasks.length;
  if (totalTasks === 0) {
    throw new Error("Cannot calculate metrics on 0 tasks");
  }

  // 1. Success Rates
  const scheduledCount = outcomes.filter(o => o.status === "SCHEDULED").length;
  const unscheduledCount = totalTasks - scheduledCount;
  const schedulingSuccessRate = scheduledCount / totalTasks;

  // 2. Reason rates
  const deadlineExceeded = outcomes.filter(o => o.reason === "DEADLINE_EXCEEDED").length;
  const resourceConflict = outcomes.filter(o => o.reason === "RESOURCE_CONFLICT").length;
  const noWindow = outcomes.filter(o => o.reason === "NO_CANDIDATE_WINDOWS" || o.reason === "NO_FEASIBLE_WINDOW").length;

  const deadlineMissRate = deadlineExceeded / totalTasks;
  const resourceConflictRate = resourceConflict / totalTasks;
  const noWindowRate = noWindow / totalTasks;

  // 3. Waiting Times
  const waitingTimesMs: number[] = [];
  for (const res of reservations) {
    const task = tasks.find(t => t.id === res.missionTaskId);
    if (task) {
      const waitMs = res.allocatedStart.getTime() - task.createdAt.getTime();
      waitingTimesMs.push(Math.max(0, waitMs));
    }
  }

  let averageWaitingTimeMs = 0;
  let p95WaitingTimeMs = 0;

  let maxWaitingTimeMs = 0;

  if (waitingTimesMs.length > 0) {
    // Average
    const sum = waitingTimesMs.reduce((a, b) => a + b, 0);
    averageWaitingTimeMs = sum / waitingTimesMs.length;

    // P95 Deterministic Sort
    // OrbitMesh Scheduler Lab uses the deterministic zero-based index floor(n * 0.95)
    // after sorting scheduled-task waiting times ascending.
    const sorted = [...waitingTimesMs].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    p95WaitingTimeMs = sorted[p95Index]!;
    
    // Max Waiting Time
    maxWaitingTimeMs = sorted[sorted.length - 1]!;
  }

  // 4. Contact-window utilization
  const totalReservedSeconds = reservations.reduce((acc, res) => {
    return acc + (res.allocatedEnd.getTime() - res.allocatedStart.getTime()) / 1000;
  }, 0);

  const sumWindowDurations = windows.reduce((acc, w) => acc + w.durationSeconds, 0);
  const contactWindowUtilization = sumWindowDurations > 0 ? totalReservedSeconds / sumWindowDurations : 0;

  // 5. Ground-station utilization (UNION of windows)
  // Group windows by station
  const windowsByStation = new Map<string, LabContactWindow[]>();
  for (const w of windows) {
    const list = windowsByStation.get(w.groundStationId) || [];
    list.push(w);
    windowsByStation.set(w.groundStationId, list);
  }

  let totalUniqueStationAvailableSeconds = 0;
  for (const [_, stnWindows] of windowsByStation.entries()) {
    // Sort ascending by aos
    const sorted = [...stnWindows].sort((a, b) => a.aos.getTime() - b.aos.getTime());
    const merged: { start: number, end: number }[] = [];

    for (const w of sorted) {
      if (merged.length === 0) {
        merged.push({ start: w.aos.getTime(), end: w.los.getTime() });
      } else {
        const last = merged[merged.length - 1]!;
        if (w.aos.getTime() <= last.end) {
          last.end = Math.max(last.end, w.los.getTime());
        } else {
          merged.push({ start: w.aos.getTime(), end: w.los.getTime() });
        }
      }
    }

    for (const interval of merged) {
      totalUniqueStationAvailableSeconds += (interval.end - interval.start) / 1000;
    }
  }

  const groundStationUtilization = totalUniqueStationAvailableSeconds > 0 
    ? totalReservedSeconds / totalUniqueStationAvailableSeconds 
    : 0;

  // 6. Success by Priority
  const successByPriority: Record<number, number> = {};
  const tasksByPriority = new Map<number, { total: number; scheduled: number }>();
  let highScheduled = 0, highTotal = 0;
  let mediumScheduled = 0, mediumTotal = 0;
  let lowScheduled = 0, lowTotal = 0;

  for (const t of tasks) {
    if (!tasksByPriority.has(t.priority)) {
      tasksByPriority.set(t.priority, { total: 0, scheduled: 0 });
    }
    tasksByPriority.get(t.priority)!.total++;
    
    let isScheduled = false;
    const outcome = outcomes.find(o => o.taskId === t.id);
    if (outcome && outcome.status === "SCHEDULED") {
      tasksByPriority.get(t.priority)!.scheduled++;
      isScheduled = true;
    }
    
    if (t.priority >= 8) {
      highTotal++;
      if (isScheduled) highScheduled++;
    } else if (t.priority >= 4) {
      mediumTotal++;
      if (isScheduled) mediumScheduled++;
    } else {
      lowTotal++;
      if (isScheduled) lowScheduled++;
    }
  }

  for (const [prio, counts] of tasksByPriority.entries()) {
    successByPriority[prio] = counts.scheduled / counts.total;
  }

  const highPrioritySuccess = highTotal > 0 ? highScheduled / highTotal : 0;
  const mediumPrioritySuccess = mediumTotal > 0 ? mediumScheduled / mediumTotal : 0;
  const lowPrioritySuccess = lowTotal > 0 ? lowScheduled / lowTotal : 0;

  // 7. Weighted Priority Success
  let totalWeightedScheduled = 0;
  let totalWeightedPossible = 0;
  for (const t of tasks) {
    totalWeightedPossible += t.priority;
    const outcome = outcomes.find(o => o.taskId === t.id);
    if (outcome && outcome.status === "SCHEDULED") {
      totalWeightedScheduled += t.priority;
    }
  }
  const priorityWeightedSuccess = totalWeightedPossible > 0 ? totalWeightedScheduled / totalWeightedPossible : 0;

  return {
    scheduledCount,
    unscheduledCount,
    schedulingSuccessRate,
    deadlineMissRate,
    noWindowRate,
    resourceConflictRate,
    averageWaitingTimeMs,
    p95WaitingTimeMs,
    maxWaitingTimeMs,
    contactWindowUtilization,
    groundStationUtilization,
    successByPriority,
    priorityWeightedSuccess,
    highPrioritySuccess,
    mediumPrioritySuccess,
    lowPrioritySuccess
  };
}
