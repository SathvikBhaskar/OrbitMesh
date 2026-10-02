export interface SchedulerResult {
  scheduled: number;
  unscheduled: number;
  results: TaskOutcome[];
  metrics?: any;
  scoreBreakdowns?: any[];
}

export interface TaskOutcome {
  taskId: string;
  status: 'SCHEDULED' | 'UNSCHEDULED';
  reservationId?: string;
  reason?: string;
}

export interface CandidateWindow {
  id: string;
  satelliteId: string;
  groundStationId: string;
  aos: Date;
  los: Date;
}
