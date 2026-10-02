/**
 * OrbitMesh Phase 5.2 - Operational Event & Anti-Thrashing Dynamic Replanning Types
 */

export type OperationalEventType =
  | "STATION_OUTAGE"
  | "STATION_RESTORED"
  | "TASK_PREEMPTION"
  | "CAPACITY_RELEASE";

export interface OperationalReplanningOptions {
  referenceTime?: Date | undefined;
  freezeHorizonSeconds?: number | undefined; // Default: 900s (15 minutes)
  scoreHysteresisThreshold?: number | undefined; // Default: 0.05
  userId: string;
  policy?: "HYBRID" | "PRIORITY" | "FCFS" | "URGENCY" | undefined;
  skipVersionIncrement?: boolean | undefined;
}

export interface StationOutageEvent {
  type: "STATION_OUTAGE";
  groundStationId: string;
  outageStart: Date;
  outageEnd: Date;
  reason?: string | undefined;
}

export interface StationRestoredEvent {
  type: "STATION_RESTORED";
  groundStationId: string;
  restoredAt: Date;
}

export interface TaskPreemptionEvent {
  type: "TASK_PREEMPTION";
  taskId: string;
  requestedBy?: string | undefined;
}

export interface CapacityReleaseEvent {
  type: "CAPACITY_RELEASE";
  releasedReservationId: string;
  reason?: string | undefined;
}

export type OperationalEvent =
  | StationOutageEvent
  | StationRestoredEvent
  | TaskPreemptionEvent
  | CapacityReleaseEvent;

export interface PreemptionCandidate {
  reservationId: string;
  taskId: string;
  taskPriority: number;
  slackSeconds: number;
  durationSeconds: number;
  allocatedStart: Date;
  allocatedEnd: Date;
  groundStationId: string;
  satelliteId: string;
  contactWindowId: string;
}

/**
 * Checks if a reservation is dynamically execution frozen based on referenceTime and freezeHorizon.
 * Invariant: Derived dynamically — never persisted as a secondary source of truth.
 *
 * A reservation is EXECUTION_FROZEN if its allocated start is within [referenceTime, referenceTime + freezeHorizon]
 * and the pass has not already finished (allocatedEnd > referenceTime).
 */
export function isExecutionFrozen(
  reservation: { allocatedStart: Date; allocatedEnd: Date },
  referenceTime: Date = new Date(),
  freezeHorizonSeconds: number = 900
): boolean {
  const refMs = referenceTime.getTime();
  const startMs = new Date(reservation.allocatedStart).getTime();
  const endMs = new Date(reservation.allocatedEnd).getTime();
  const freezeBoundaryMs = refMs + freezeHorizonSeconds * 1000;

  // Pass has not yet finished, and starts within the imminent freeze window
  return endMs > refMs && startMs <= freezeBoundaryMs;
}

/**
 * Deterministic preemption comparator:
 * 1. Priority loss: Lower priority tasks displaced first (priority ASC)
 * 2. Slack distance: Tasks with more slack buffer displaced first (slack DESC)
 * 3. Duration: Shorter duration tasks displaced first (duration ASC)
 * 4. Deterministic Tie-Breaker: reservationId ASC
 */
export function comparePreemptionCandidates(
  a: PreemptionCandidate,
  b: PreemptionCandidate
): number {
  if (a.taskPriority !== b.taskPriority) {
    return a.taskPriority - b.taskPriority;
  }
  if (a.slackSeconds !== b.slackSeconds) {
    return b.slackSeconds - a.slackSeconds;
  }
  if (a.durationSeconds !== b.durationSeconds) {
    return a.durationSeconds - b.durationSeconds;
  }
  return a.reservationId.localeCompare(b.reservationId);
}

export interface OperationalReplanningResult {
  eventType: OperationalEventType;
  scheduleVersionBefore: number;
  scheduleVersionAfter: number;
  isNoOp: boolean;
  displacedReservationsCount: number;
  frozenBlockedCount: number;
  rescuedCount: number;
  unrescuableCount: number;
  displacedReservationIds: string[];
  rescuedReservationIds: string[];
  unrescuableTaskIds: string[];
  frozenBlockedReservationIds: string[];
  details: {
    action: string;
    entityId: string;
    reason: string;
    metadata?: Record<string, any> | undefined;
  }[];
}
