/**
 * OrbitMesh Phase 5.3 - Event Control Plane Types & Precedence Rules
 *
 * Formalizes:
 * 1. Event Processing Precedence (Deterministic hierarchy: Outage > Orbital > Preemption > Opportunity)
 * 2. Dispatch Urgency (IMMEDIATE vs COALESCIBLE)
 * 3. Ledger Lifecycle (RECEIVED -> COALESCED -> PROCESSING -> COMPLETED / FAILED / SUPERSEDED)
 * 4. Idempotency Receipt
 */

export type LedgerEventStatus =
  | "RECEIVED"
  | "COALESCED"
  | "PROCESSING"
  | "COMPLETED"
  | "SUPERSEDED"
  | "REJECTED"
  | "FAILED";

export type EventDispatchUrgency = "IMMEDIATE" | "COALESCIBLE";

export type OrchestratedEventType =
  | "STATION_OUTAGE"
  | "ORBITAL_UPDATE"
  | "TASK_PREEMPTION"
  | "STATION_RESTORED"
  | "CAPACITY_RELEASE";

export interface OrchestratedEventInput {
  idempotencyKey: string;
  eventType: OrchestratedEventType;
  payload: Record<string, any>;
  urgency?: EventDispatchUrgency | undefined;
}

/**
 * Event Processing Precedence:
 * Level 1: Hardware Inoperability (STATION_OUTAGE) - Clear dead windows first
 * Level 2: Orbital Geometry Shifts (ORBITAL_UPDATE) - Re-align geometric bounds (W₁)
 * Level 3: Contention Preemption (TASK_PREEMPTION) - Fit urgent tasks into surviving windows
 * Level 4: Opportunity Allocation (STATION_RESTORED, CAPACITY_RELEASE) - Absorb pending tasks onto recovered capacity
 */
export function getEventPrecedence(eventType: OrchestratedEventType): number {
  switch (eventType) {
    case "STATION_OUTAGE":
      return 1;
    case "ORBITAL_UPDATE":
      return 2;
    case "TASK_PREEMPTION":
      return 3;
    case "STATION_RESTORED":
    case "CAPACITY_RELEASE":
      return 4;
    default:
      return 99;
  }
}

/**
 * Dispatch Urgency:
 * Safety-Critical (IMMEDIATE): Cannot be delayed by debounce timers if they invalidate current schedule
 * Opportunity / Optimization (COALESCIBLE): Can be batched and coalesced within debounce window
 */
export function getEventUrgency(eventType: OrchestratedEventType): EventDispatchUrgency {
  switch (eventType) {
    case "STATION_OUTAGE":
    case "ORBITAL_UPDATE":
      return "IMMEDIATE";
    case "TASK_PREEMPTION":
    case "STATION_RESTORED":
    case "CAPACITY_RELEASE":
      return "COALESCIBLE";
    default:
      return "COALESCIBLE";
  }
}

/**
 * Deterministic Precedence Comparator:
 * 1. Event Processing Precedence (1 -> 2 -> 3 -> 4)
 * 2. Idempotency Key ASC (deterministic tie-breaker)
 */
export function compareEventPrecedence(
  a: { eventType: OrchestratedEventType; idempotencyKey: string },
  b: { eventType: OrchestratedEventType; idempotencyKey: string }
): number {
  const pA = getEventPrecedence(a.eventType);
  const pB = getEventPrecedence(b.eventType);
  if (pA !== pB) {
    return pA - pB;
  }
  return a.idempotencyKey.localeCompare(b.idempotencyKey);
}

export interface ControlPlaneOptions {
  referenceTime?: Date | undefined;
  freezeHorizonSeconds?: number | undefined;
  debounceMs?: number | undefined;
  policy?: "HYBRID" | "PRIORITY" | "FCFS" | "URGENCY" | undefined;
  userId: string;
}

export interface BatchExecutionReceipt {
  batchId: string;
  status: "COMPLETED" | "FAILED" | "RETRYABLE";
  scheduleVersionBefore: number;
  scheduleVersionAfter: number;
  isNoOp: boolean;
  eventsProcessedCount: number;
  supersededCount: number;
  totalDisplacedCount: number;
  totalRescuedCount: number;
  totalUnrescuableCount: number;
  frozenBlockedCount: number;
  eventResults: {
    idempotencyKey: string;
    eventType: string;
    displacedCount: number;
    rescuedCount: number;
    unrescuableCount: number;
    frozenBlockedCount: number;
    details: any[];
  }[];
  createdAt: Date;
  completedAt: Date;
}
