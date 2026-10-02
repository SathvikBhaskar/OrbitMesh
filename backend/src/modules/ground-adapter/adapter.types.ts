export type DispatchHandshakeState =
  | "PREPARED"
  | "STAGED_ACK"
  | "ARMED"
  | "REJECTED"
  | "EXPIRED";

export type AdapterTransportHealth =
  | "CONNECTED"
  | "COMMUNICATION_GAP";

export interface DispatchAttemptRecord {
  id: string;
  reservationId: string;
  dispatchId: string;
  attemptNumber: number;
  state: DispatchHandshakeState;
  transportHealth: AdapterTransportHealth;
  clockOffsetMs: number;
  stagedAt: Date | null;
  armedAt: Date | null;
  expiredAt: Date | null;
  retryCount: number;
  lastError: string | null;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClockSkewResult {
  isAcceptable: boolean;
  clockOffsetMs: number;
  rejectionReason?: "CLOCK_SKEW_FUTURE" | "CLOCK_SKEW_EXCESSIVE_PAST";
}

export interface SequenceGapResult {
  hasGap: boolean;
  expectedSeq: number;
  receivedSeq: number;
  missingSeqs: number[];
}

export interface IngestTelemetryOptions {
  dispatchId: string;
  sequenceNumber: number;
  sourceTimestamp: Date;
  idempotencyKey: string;
  bytesTransferred?: number;
  isSnapshot?: boolean;
  metrics?: Record<string, any>;
}
