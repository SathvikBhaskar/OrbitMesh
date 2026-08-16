import { TaskOutcome } from "../scheduler/types";

export interface WorkloadConfig {
  seed: string;
  referenceTime: Date;
  taskCount: number;
  satelliteCount: number;
  stationCount: number;
  
  // Regimes
  deadlineRegime: 'LOOSE' | 'MEDIUM' | 'TIGHT';
  priorityDistribution: 'BALANCED' | 'HIGH_HEAVY' | 'LOW_HEAVY';
  durationDistribution: 'SHORT' | 'MIXED' | 'LONG';
  
  // Base config for generation
  arrivalSpreadSeconds: number;
}

export interface MetricResults {
  scheduledCount: number;
  unscheduledCount: number;
  schedulingSuccessRate: number; // scheduled / total_tasks
  
  deadlineMissRate: number; // DEADLINE_EXCEEDED / total_tasks
  noWindowRate: number; // NO_CANDIDATE_WINDOWS or NO_FEASIBLE_WINDOW (general)
  resourceConflictRate: number; // RESOURCE_CONFLICT / total_tasks
  
  averageWaitingTimeMs: number;
  p95WaitingTimeMs: number;
  maxWaitingTimeMs: number;
  
  contactWindowUtilization: number; // reserved / summed window duration
  groundStationUtilization: number; // reserved / UNION(window intervals)
  
  successByPriority: Record<number, number>; // e.g. { 10: 0.95, 9: 0.91 }
  priorityWeightedSuccess: number;
  
  highPrioritySuccess: number; // 8-10
  mediumPrioritySuccess: number; // 4-7
  lowPrioritySuccess: number; // 1-3
}

export type LabTaskOutcomeReason = 
  | "NO_CANDIDATE_WINDOWS"
  | "NO_FEASIBLE_WINDOW"
  | "DEADLINE_EXCEEDED"
  | "RESOURCE_CONFLICT";

export interface LabTaskOutcome {
  taskId: string;
  status: "SCHEDULED" | "UNSCHEDULED";
  reservationId?: string;
  reason?: LabTaskOutcomeReason;
}
