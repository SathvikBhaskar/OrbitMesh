export interface WorkloadFeatures {
  taskCount: number;
  totalTaskDemandSeconds: number;
  usableCapacitySeconds: number;
  loadPressure: number;
  medianDeadlinePressure: number;
  p10DeadlinePressure: number;
  tightTaskFraction: number;
  highPriorityFraction: number;
  meanGapSeconds: number;
  p10GapSeconds: number;
  largestGapSeconds: number;
  fragmentationPressure: number;
}

export interface Task {
  id: string;
  duration_ms: number;
  priority: number;
  deadline: string | Date;
  status?: string;
  created_at?: string | Date;
  [key: string]: any;
}

export interface ContactWindow {
  id: string;
  ground_station_id: string;
  aos: string | Date;
  los: string | Date;
  [key: string]: any;
}

export interface Reservation {
  id: string;
  ground_station_id: string;
  aos?: string | Date;
  los?: string | Date;
  allocated_start?: string | Date;
  allocated_end?: string | Date;
  [key: string]: any;
}

export type PolicyReason =
  | "EXTREME_DEADLINE_PRESSURE"
  | "HIGH_LOAD_PRIORITY_PRESSURE"
  | "BALANCED_WORKLOAD";
