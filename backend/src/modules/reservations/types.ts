export type ValidationErrorCode = 
  | "TASK_NOT_FOUND"
  | "CONTACT_WINDOW_NOT_FOUND"
  | "OUTSIDE_CONTACT_WINDOW"
  | "SATELLITE_MISMATCH"
  | "GROUND_STATION_MISMATCH"
  | "STATION_CONFLICT"
  | "SATELLITE_CONFLICT"
  | "DURATION_UNSATISFIED"
  | "DEADLINE_MISSED"
  | "INVALID_TIME_RANGE";

export interface ValidationError {
  code: ValidationErrorCode;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ReservationRequest {
  taskId: string;
  contactWindowId: string;
  satelliteId?: string;
  groundStationId?: string;
  startTime: Date;
  endTime: Date;
  locked?: boolean;
}
