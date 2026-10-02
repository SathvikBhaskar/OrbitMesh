/**
 * Phase 5.5: Operational Execution Awareness & Telemetry Bridge Types
 */

export type ExecutionState =
  | "SCHEDULED"
  | "EXECUTION_READY"
  | "DISPATCHED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED";

export type FailureReason =
  | "DISPATCH_REJECTED"
  | "NO_AOS"
  | "GROUND_HARDWARE_FAULT"
  | "SATELLITE_UNAVAILABLE"
  | "EXECUTION_ABORTED"
  | "TIMEOUT"
  | "UNKNOWN";

export type ExecutionEventType =
  | "DISPATCH_ACK"
  | "AOS_ACQUIRED"
  | "TELEMETRY_STATS"
  | "LOS_TERMINATED"
  | "GROUND_HARDWARE_FAULT"
  | "WATCHDOG_TIMEOUT";

export interface InboundExecutionEvent {
  eventId: string;
  reservationId: string;
  dispatchId: string;
  eventType: ExecutionEventType;
  sourceTimestamp: string; // ISO UTC string
  receivedAt?: string;
  sequenceNumber: number;
  idempotencyKey: string;
  payload: {
    groundStationId: string;
    satelliteId: string;
    bytesTransferred?: number;
    snrDb?: number;
    carrierLocked?: boolean;
    failureReason?: FailureReason;
    details?: Record<string, unknown>;
  };
}

export interface DispatchManifest {
  dispatchId: string;
  reservationId: string;
  satelliteId: string;
  groundStationId: string;
  window: {
    aos: string;
    los: string;
  };
  allocatedTime: {
    start: string;
    end: string;
  };
  rfConfiguration: {
    frequencyBand: string;
    minDataRateMbps: number;
  };
  taskManifest: {
    taskId: string;
    priority: number;
    targetBytes: number;
    remainingBytes: number;
  };
  dispatchedAt: string;
}

export interface ExecutionTransitionResult {
  reservationId: string;
  dispatchId: string;
  previousState: ExecutionState;
  newState: ExecutionState;
  bytesTransferred: number;
  failureReason?: FailureReason | undefined;
  hasSchedulingConsequence: boolean;
  schedulingConsequenceType?: "NONE" | "REPLAN_REMAINDER" | "RESCUE_TASK" | "RELEASE_SLOT";
}

/**
 * Validates permitted transitions in the execution state machine.
 */
export function isValidExecutionTransition(current: ExecutionState, next: ExecutionState): boolean {
  if (current === next) return true; // Idempotent self-transition

  switch (current) {
    case "SCHEDULED":
      return next === "EXECUTION_READY" || next === "FAILED";
    case "EXECUTION_READY":
      return next === "DISPATCHED" || next === "FAILED";
    case "DISPATCHED":
      return next === "IN_PROGRESS" || next === "FAILED";
    case "IN_PROGRESS":
      return next === "COMPLETED" || next === "PARTIAL" || next === "FAILED";
    case "COMPLETED":
    case "PARTIAL":
    case "FAILED":
      return false; // Terminal states are immutable
    default:
      return false;
  }
}

export function isTerminalExecutionState(state: ExecutionState): boolean {
  return state === "COMPLETED" || state === "PARTIAL" || state === "FAILED";
}
