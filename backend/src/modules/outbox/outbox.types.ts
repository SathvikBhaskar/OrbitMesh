/**
 * Phase 5.7: Workstream 5.7.1 — Transactional Outbox Types
 */

export type OutboxMessageStatus =
  | "PENDING"
  | "DELIVERING"
  | "DELIVERED"
  | "RETRY"
  | "DLQ";

export type OutboxMessageType =
  | "STAGE_DISPATCH"
  | "ARM_DISPATCH"
  | "ABORT_PASS"
  | "RF_INHIBIT"
  | "STATUS_QUERY";

export interface OutboxMessageRecord {
  id: string;
  messageId: string;
  dispatchId: string;
  reservationId: string;
  providerId: string;
  messageType: OutboxMessageType;
  payload: Record<string, unknown>;
  status: OutboxMessageStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lastAttemptAt?: Date | null;
  lastError?: string | null;
  createdAt: Date;
  sentAt?: Date | null;
  expiresAt: Date;
}

export interface CreateOutboxMessageInput {
  messageId: string;
  dispatchId: string;
  reservationId: string;
  providerId: string;
  messageType: OutboxMessageType;
  payload?: Record<string, unknown>;
  expiresAt: Date;
  maxAttempts?: number;
}

export interface AtomicExecutionReadyResult {
  reservationId: string;
  dispatchId: string;
  messageId: string;
  attemptNumber: number;
  outboxMessage: OutboxMessageRecord;
}
