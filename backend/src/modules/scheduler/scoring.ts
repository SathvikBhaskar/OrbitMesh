/**
 * OrbitMesh Phase 4.3 - Standardized Metric Definitions & Scoring Engine
 * 
 * Formal metric calculations and multi-attribute hybrid scoring function.
 * 
 * Invariant: Hard constraints (ConstraintValidationService) are strictly evaluated
 * upstream of scoring. Scoring is only applied to FEASIBLE candidates.
 */

import { TaskOutcome } from "./types";

export interface PolicyBenchmarkMetrics {
  scheduledTaskCount: number;
  unscheduledTaskCount: number;
  weightedPriorityValue: number;      // sum of priority of all scheduled tasks
  deadlineSuccessRate: number;        // (scheduledOnTime / totalTasks) * 100
  totalScheduledDurationSeconds: number;
  stationUtilizationPercent: number;  // (occupiedSeconds / totalWindowSeconds) * 100
  satelliteUtilizationPercent: number;
  deadlineMissCount: number;
  averageSlackSecondsAtAllocation: number;
}

export interface HybridScoringWeights {
  priorityWeight: number; // default: 0.4
  urgencyWeight: number;  // default: 0.4
  qualityWeight: number;  // default: 0.2
}

export const DEFAULT_HYBRID_WEIGHTS: HybridScoringWeights = {
  priorityWeight: 0.4,
  urgencyWeight: 0.4,
  qualityWeight: 0.2,
};

/**
 * Calculates multi-attribute score for a feasible (Task, Window) candidate:
 * Score = w_prio * NormPriority + w_urg * NormUrgency + w_qual * NormElevation
 */
export function calculateHybridCandidateScore(
  task: { priority: number; durationSeconds: number; deadline: Date },
  window: { maxElevationDeg?: number | null },
  referenceTime: Date = new Date(),
  weights: HybridScoringWeights = DEFAULT_HYBRID_WEIGHTS
): {
  compositeScore: number;
  normPriority: number;
  normUrgency: number;
  normElevation: number;
} {
  // 1. Normalized Priority: priority in [1, 10] -> [0.1, 1.0]
  const normPriority = Math.max(0.1, Math.min(1.0, task.priority / 10.0));

  // 2. Normalized Urgency:
  // Urgency ratio = duration / remainingTime
  const remainingSeconds = (task.deadline.getTime() - referenceTime.getTime()) / 1000;
  let normUrgency = 0;
  if (remainingSeconds <= 0) {
    normUrgency = 1.0; // maximum urgency
  } else {
    const ratio = task.durationSeconds / Math.max(1, remainingSeconds);
    normUrgency = Math.max(0.0, Math.min(1.0, ratio));
  }

  // 3. Normalized Elevation Quality: maxElevationDeg in [0, 90] -> [0.0, 1.0]
  const elev = window.maxElevationDeg ?? 45.0;
  const normElevation = Math.max(0.0, Math.min(1.0, elev / 90.0));

  const compositeScore =
    weights.priorityWeight * normPriority +
    weights.urgencyWeight * normUrgency +
    weights.qualityWeight * normElevation;

  return {
    compositeScore: Number(compositeScore.toFixed(4)),
    normPriority: Number(normPriority.toFixed(4)),
    normUrgency: Number(normUrgency.toFixed(4)),
    normElevation: Number(normElevation.toFixed(4)),
  };
}

/**
 * Computes all 9 standardized PolicyBenchmarkMetrics objectively.
 */
export function calculateBenchmarkMetrics(
  tasks: Array<{ id: string; priority: number; deadline: Date; durationSeconds: number }>,
  windows: Array<{ id: string; groundStationId: string; satelliteId: string; durationSeconds: number; aos: Date; los: Date }>,
  reservations: Array<{ missionTaskId: string; contactWindowId: string; allocatedStart: Date; allocatedEnd: Date; satelliteId?: string; groundStationId?: string }>,
  outcomes: TaskOutcome[]
): PolicyBenchmarkMetrics {
  const totalTasks = tasks.length;
  if (totalTasks === 0) {
    return {
      scheduledTaskCount: 0,
      unscheduledTaskCount: 0,
      weightedPriorityValue: 0,
      deadlineSuccessRate: 0,
      totalScheduledDurationSeconds: 0,
      stationUtilizationPercent: 0,
      satelliteUtilizationPercent: 0,
      deadlineMissCount: 0,
      averageSlackSecondsAtAllocation: 0,
    };
  }

  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const resvMap = new Map(reservations.map(r => [r.missionTaskId, r]));

  // 1. Scheduled / Unscheduled Counts
  const scheduledOutcomes = outcomes.filter(o => o.status === "SCHEDULED");
  const unscheduledOutcomes = outcomes.filter(o => o.status === "UNSCHEDULED");
  const scheduledTaskCount = scheduledOutcomes.length;
  const unscheduledTaskCount = unscheduledOutcomes.length;

  // 2. Weighted Priority Value (sum of priorities of scheduled tasks)
  let weightedPriorityValue = 0;
  let scheduledOnTimeCount = 0;
  let totalScheduledDurationSeconds = 0;
  let totalSlackSeconds = 0;

  for (const o of scheduledOutcomes) {
    const task = taskMap.get(o.taskId);
    const resv = resvMap.get(o.taskId);

    if (task) {
      weightedPriorityValue += task.priority;
    }

    if (task && resv) {
      const durSec = (resv.allocatedEnd.getTime() - resv.allocatedStart.getTime()) / 1000;
      totalScheduledDurationSeconds += durSec;

      const slack = (task.deadline.getTime() - resv.allocatedEnd.getTime()) / 1000;
      totalSlackSeconds += slack;

      if (resv.allocatedEnd.getTime() <= task.deadline.getTime()) {
        scheduledOnTimeCount++;
      }
    }
  }

  // 3. Deadline Success Rate
  const deadlineSuccessRate = Number(((scheduledOnTimeCount / totalTasks) * 100).toFixed(2));

  // 4. Deadline Miss Count (unscheduled tasks whose failure reason is deadline exceeded/missed)
  const deadlineMissCount = unscheduledOutcomes.filter(
    o => o.reason === "DEADLINE_EXCEEDED" || o.reason === "DEADLINE_MISSED" || o.reason === "INSUFFICIENT_SLACK"
  ).length;

  // 5. Utilization metrics
  const totalWindowSeconds = windows.reduce((acc, w) => acc + w.durationSeconds, 0);
  const stationUtilizationPercent = totalWindowSeconds > 0
    ? Number(((totalScheduledDurationSeconds / totalWindowSeconds) * 100).toFixed(2))
    : 0;

  // Satellite utilization (ratio of scheduled duration to total contact window pass time)
  const satelliteUtilizationPercent = stationUtilizationPercent;

  // 6. Average Slack at Allocation
  const averageSlackSecondsAtAllocation = scheduledTaskCount > 0
    ? Number((totalSlackSeconds / scheduledTaskCount).toFixed(2))
    : 0;

  return {
    scheduledTaskCount,
    unscheduledTaskCount,
    weightedPriorityValue,
    deadlineSuccessRate,
    totalScheduledDurationSeconds,
    stationUtilizationPercent,
    satelliteUtilizationPercent,
    deadlineMissCount,
    averageSlackSecondsAtAllocation,
  };
}
