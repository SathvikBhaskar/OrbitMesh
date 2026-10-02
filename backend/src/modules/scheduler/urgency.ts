/**
 * OrbitMesh Phase 4.2 - Deadline Urgency & Slack-Time Dynamics
 * 
 * Formal urgency metrics, slack-time calculations, deterministic tie-breakers,
 * and candidate feasibility evaluation.
 * 
 * Pipeline order:
 * Candidate -> Hard Constraints (ConstraintValidationService) -> Feasible? 
 *   NO  -> reject
 *   YES -> urgency / slack -> policy decision
 */

import { constraintValidator } from "../reservations/constraint-validator";

export interface TaskUrgencyProfile {
  taskId: string;
  satelliteId: string;
  priority: number;
  createdAt: Date;
  deadline: Date;
  durationSeconds: number;
  requiredFrequencyBand?: string | null | undefined;
  minDataRateMbps?: number | null | undefined;

  // Feasibility status strictly verified by Hard Constraint Validator
  isFeasible: boolean;
  infeasibilityReason?: "DEADLINE_EXCEEDED" | "NO_FEASIBLE_WINDOW" | "INSUFFICIENT_SLACK" | "INCOMPATIBLE_FREQUENCY_BAND" | "INSUFFICIENT_STATION_DATA_RATE" | undefined;

  // Urgency & Slack Metrics
  feasibleCandidateCount: number;
  earliestFeasibleWindowId?: string | undefined;
  earliestStart?: Date | undefined;
  earliestEnd?: Date | undefined;
  slackSeconds: number;
  urgencyRatio: number;
  isCriticalSlack: boolean;
  hasAlternativeWindow: boolean;
}

export interface CandidateWindowFeasibility {
  windowId: string;
  groundStationId: string;
  aos: Date;
  los: Date;
  isFeasible: boolean;
  earliestStart?: Date | undefined;
  earliestEnd?: Date | undefined;
  slackSeconds: number;
  infeasibilityReason?: string | undefined;
}

/**
 * Formal Slack Time Metric:
 * Slack(T, W) = DL_T - (AOS_W + D_T)
 * Calculated in seconds.
 */
export function calculateWindowSlack(taskDeadline: Date, windowAos: Date, durationSeconds: number): number {
  const earliestPossibleEndMs = windowAos.getTime() + durationSeconds * 1000;
  return (taskDeadline.getTime() - earliestPossibleEndMs) / 1000;
}

/**
 * Formal Interval Slack Time Metric:
 * Slack(T, interval) = DL_T - intervalEnd
 * Calculated in seconds.
 */
export function calculateIntervalSlack(taskDeadline: Date, intervalEnd: Date): number {
  return (taskDeadline.getTime() - intervalEnd.getTime()) / 1000;
}

/**
 * Formal Urgency Ratio Metric:
 * UrgencyRatio(T, t_ref) = D_T / max(1, DL_T - t_ref)
 * Where duration and remaining time are measured in seconds.
 */
export function calculateUrgencyRatio(
  durationSeconds: number,
  taskDeadline: Date,
  referenceTime: Date = new Date()
): number {
  const remainingSeconds = (taskDeadline.getTime() - referenceTime.getTime()) / 1000;
  if (remainingSeconds <= 0) {
    return Infinity; // Past deadline or exact deadline
  }
  return durationSeconds / Math.max(1, remainingSeconds);
}

/**
 * Returns true if the task has negative slack (infeasible on window).
 */
export function isNegativeSlack(slackSeconds: number): boolean {
  return slackSeconds < 0;
}

/**
 * Critical Slack threshold: by default <= 1800s (30 minutes).
 */
export function isCriticalSlack(slackSeconds: number, thresholdSeconds: number = 1800): boolean {
  return slackSeconds >= 0 && slackSeconds <= thresholdSeconds;
}

/**
 * Ample Slack threshold: by default >= 7200s (2 hours).
 */
export function isAmpleSlack(slackSeconds: number, thresholdSeconds: number = 7200): boolean {
  return slackSeconds >= thresholdSeconds;
}

/**
 * Deterministic Urgency Tie-Breaker:
 * Resolved deterministically by:
 *   1. priority DESC
 *   2. createdAt ASC
 *   3. id ASC
 */
export function compareUrgencyTieBreaker(
  taskA: { priority: number; createdAt: Date; id: string },
  taskB: { priority: number; createdAt: Date; id: string }
): number {
  // 1. Priority DESC (higher priority first)
  if (taskA.priority !== taskB.priority) {
    return taskB.priority - taskA.priority;
  }
  // 2. CreatedAt ASC (older task first)
  const timeDiff = taskA.createdAt.getTime() - taskB.createdAt.getTime();
  if (timeDiff !== 0) {
    return timeDiff;
  }
  // 3. ID ASC (lexicographical)
  return taskA.id.localeCompare(taskB.id);
}

/**
 * Evaluates candidate windows for a given task against all hard constraints
 * and calculates urgency & slack dynamics.
 */
export function buildTaskUrgencyProfile(
  task: {
    id: string;
    satelliteId: string;
    priority: number;
    createdAt: Date;
    deadline: Date;
    durationSeconds: number;
    requiredFrequencyBand?: string | null;
    minDataRateMbps?: number | null;
  },
  candidateWindows: Array<{
    id: string;
    satelliteId: string;
    groundStationId: string;
    aos: Date;
    los: Date;
    durationSeconds: number;
  }>,
  groundStationsById: Map<string, {
    supportedFrequencyBands?: string[] | null;
    maxDataRateMbps?: number | null;
    maxConcurrentContacts?: number | null;
  }>,
  activeReservationsByStation: Map<string, Array<{ allocatedStart: Date; allocatedEnd: Date; satelliteId: string; locked?: boolean }>>,
  referenceTime: Date = new Date(),
  criticalSlackThresholdSeconds: number = 1800
): { profile: TaskUrgencyProfile; feasibleWindows: CandidateWindowFeasibility[] } {
  const feasibleWindows: CandidateWindowFeasibility[] = [];
  let infeasibilityReason: "DEADLINE_EXCEEDED" | "NO_FEASIBLE_WINDOW" | "INSUFFICIENT_SLACK" | "INCOMPATIBLE_FREQUENCY_BAND" | "INSUFFICIENT_STATION_DATA_RATE" | undefined = undefined;

  // Check if deadline is already expired in past relative to reference time
  if (task.deadline.getTime() <= referenceTime.getTime()) {
    return {
      profile: {
        taskId: task.id,
        satelliteId: task.satelliteId,
        priority: task.priority,
        createdAt: task.createdAt,
        deadline: task.deadline,
        durationSeconds: task.durationSeconds,
        requiredFrequencyBand: task.requiredFrequencyBand,
        minDataRateMbps: task.minDataRateMbps,
        isFeasible: false,
        infeasibilityReason: "DEADLINE_EXCEEDED",
        feasibleCandidateCount: 0,
        slackSeconds: (task.deadline.getTime() - referenceTime.getTime()) / 1000,
        urgencyRatio: Infinity,
        isCriticalSlack: true,
        hasAlternativeWindow: false,
      },
      feasibleWindows: [],
    };
  }

  if (candidateWindows.length === 0) {
    return {
      profile: {
        taskId: task.id,
        satelliteId: task.satelliteId,
        priority: task.priority,
        createdAt: task.createdAt,
        deadline: task.deadline,
        durationSeconds: task.durationSeconds,
        requiredFrequencyBand: task.requiredFrequencyBand,
        minDataRateMbps: task.minDataRateMbps,
        isFeasible: false,
        infeasibilityReason: "NO_FEASIBLE_WINDOW",
        feasibleCandidateCount: 0,
        slackSeconds: Infinity,
        urgencyRatio: calculateUrgencyRatio(task.durationSeconds, task.deadline, referenceTime),
        isCriticalSlack: false,
        hasAlternativeWindow: false,
      },
      feasibleWindows: [],
    };
  }

  for (const window of candidateWindows) {
    const station = groundStationsById.get(window.groundStationId);
    
    // 1. Static Window Hard Constraints (ConstraintValidationService helper)
    const windowValidation = constraintValidator.validateCandidateWindow(task, window, station);
    if (!windowValidation.valid) {
      const isBandMismatch = windowValidation.errors.some(e => e.code === "INCOMPATIBLE_FREQUENCY_BAND");
      const isRateMismatch = windowValidation.errors.some(e => e.code === "INSUFFICIENT_STATION_DATA_RATE");
      const isDeadlineExceeded = windowValidation.errors.some(e => e.code === "DEADLINE_EXCEEDED");
      const isInsufficientSlack = windowValidation.errors.some(e => e.code === "INSUFFICIENT_SLACK");

      if (isBandMismatch && !infeasibilityReason) infeasibilityReason = "INCOMPATIBLE_FREQUENCY_BAND";
      else if (isRateMismatch && !infeasibilityReason) infeasibilityReason = "INSUFFICIENT_STATION_DATA_RATE";
      else if (isDeadlineExceeded || isInsufficientSlack) infeasibilityReason = "DEADLINE_EXCEEDED";
      else if (!infeasibilityReason) infeasibilityReason = "NO_FEASIBLE_WINDOW";

      feasibleWindows.push({
        windowId: window.id,
        groundStationId: window.groundStationId,
        aos: window.aos,
        los: window.los,
        isFeasible: false,
        slackSeconds: windowValidation.slackSeconds,
        infeasibilityReason: windowValidation.errors[0]?.code,
      });
      continue;
    }

    // 2. Dynamic Interval Slot Search with Station Capacity and Satellite Transceiver Checks
    const stationResvs = activeReservationsByStation.get(window.groundStationId) || [];
    const stationCapacity = station?.maxConcurrentContacts ?? 1;
    const durationMs = task.durationSeconds * 1000;

    // Build timeline event boundaries to find earliest feasible interval
    let cursor = window.aos.getTime();
    let slotFound = false;
    let slotStart: Date | undefined;
    let slotEnd: Date | undefined;

    // Collect all reservation boundaries within window
    const endpoints = new Set<number>([window.aos.getTime()]);
    for (const r of stationResvs) {
      if (r.allocatedEnd.getTime() > window.aos.getTime() && r.allocatedStart.getTime() < window.los.getTime()) {
        endpoints.add(r.allocatedStart.getTime());
        endpoints.add(r.allocatedEnd.getTime());
      }
    }
    const sortedPoints = Array.from(endpoints).sort((a, b) => a - b);

    for (const pt of sortedPoints) {
      cursor = Math.max(cursor, pt);
      const candEnd = cursor + durationMs;

      if (candEnd > window.los.getTime()) break;
      if (candEnd > task.deadline.getTime()) {
        infeasibilityReason = "DEADLINE_EXCEEDED";
        break;
      }

      // Check station capacity at [cursor, candEnd)
      const overlappingStation = stationResvs.filter(
        r => r.allocatedStart.getTime() < candEnd && r.allocatedEnd.getTime() > cursor
      );

      // Check satellite conflict across all reservations
      const satConflict = overlappingStation.some(r => r.satelliteId === task.satelliteId);
      if (satConflict) continue;

      if (overlappingStation.length >= stationCapacity) {
        continue;
      }

      // Found earliest feasible slot
      slotFound = true;
      slotStart = new Date(cursor);
      slotEnd = new Date(candEnd);
      break;
    }

    if (slotFound && slotStart && slotEnd) {
      const intervalSlack = calculateIntervalSlack(task.deadline, slotEnd);
      feasibleWindows.push({
        windowId: window.id,
        groundStationId: window.groundStationId,
        aos: window.aos,
        los: window.los,
        isFeasible: true,
        earliestStart: slotStart,
        earliestEnd: slotEnd,
        slackSeconds: intervalSlack,
      });
    } else {
      feasibleWindows.push({
        windowId: window.id,
        groundStationId: window.groundStationId,
        aos: window.aos,
        los: window.los,
        isFeasible: false,
        slackSeconds: calculateWindowSlack(task.deadline, window.aos, task.durationSeconds),
        infeasibilityReason: infeasibilityReason || "NO_FEASIBLE_WINDOW",
      });
    }
  }

  const validFeasible = feasibleWindows.filter(w => w.isFeasible);
  const isFeasible = validFeasible.length > 0;
  const earliestFeasible = validFeasible[0];

  const primarySlack = earliestFeasible ? earliestFeasible.slackSeconds : Infinity;
  const urgencyRatio = calculateUrgencyRatio(task.durationSeconds, task.deadline, referenceTime);

  return {
    profile: {
      taskId: task.id,
      satelliteId: task.satelliteId,
      priority: task.priority,
      createdAt: task.createdAt,
      deadline: task.deadline,
      durationSeconds: task.durationSeconds,
      requiredFrequencyBand: task.requiredFrequencyBand,
      minDataRateMbps: task.minDataRateMbps,
      isFeasible,
      infeasibilityReason: isFeasible ? undefined : (infeasibilityReason || "NO_FEASIBLE_WINDOW"),
      feasibleCandidateCount: validFeasible.length,
      earliestFeasibleWindowId: earliestFeasible?.windowId,
      earliestStart: earliestFeasible?.earliestStart,
      earliestEnd: earliestFeasible?.earliestEnd,
      slackSeconds: primarySlack,
      urgencyRatio,
      isCriticalSlack: isCriticalSlack(primarySlack, criticalSlackThresholdSeconds),
      hasAlternativeWindow: validFeasible.length > 1,
    },
    feasibleWindows,
  };
}
