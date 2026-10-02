# Phase 5.7 Specification: Controlled External Execution Integration Boundary

**Status:** SPECIFICATION PENDING APPROVAL  
**Baseline Freeze:** Phase 5.4 (`b42f137`), Phase 5.5 (`e66adc4`), Phase 5.6 (`5bf0e23`)  
**Scope:** Durable Outbound Delivery, Vendor-Neutral Provider Adapter, Two-Layer Authentication, Safety Interlocks & Cross-Layer Resilience  

---

## 1. Architectural Positioning & Cardinal Invariants

Phase 5.6 established the canonical execution contract, ground adapter state machine, clock discipline hierarchy, and sequence gap recovery against an impairment simulation harness.

**Phase 5.7 transitions from simulation to a controlled external integration boundary** with external TT&C networks (e.g., AWS Ground Station, KSAT, Leaf Space, or custom CCSDS/SLE hardware basebands).

```
                      ORBITMESH CORE
                            │
               Authoritative Execution Engine
                            │
      ┌─────────────────────▼─────────────────────┐
      │       Phase 5.7 Integration Boundary      │
      │                                           │
      │  ┌─────────────────────────────────────┐  │
      │  │ 1. Transactional Outbox Worker      │  │
      │  │    (Durable at-least-once delivery) │  │
      │  └──────────────────┬──────────────────┘  │
      │                     │                     │
      │  ┌──────────────────▼──────────────────┐  │
      │  │ 2. Ground Station Provider Adapter  │  │
      │  │    (Vendor-neutral protocol mapping)│  │
      │  └──────────────────┬──────────────────┘  │
      │                     │                     │
      │  ┌──────────────────▼──────────────────┐  │
      │  │ 3. Two-Layer Security Boundary      │  │
      │  │    (mTLS identity + HMAC integrity) │  │
      │  └──────────────────┬──────────────────┘  │
      │                     │                     │
      │  ┌──────────────────▼──────────────────┐  │
      │  │ 4. Operational Safety Interlocks    │  │
      │  │    (Emergency Abort / RF Inhibit)   │  │
      │  └─────────────────────────────────────┘  │
      └─────────────────────┬─────────────────────┘
                            │  Mutual TLS / Signed Webhooks
                            ▼
               External TT&C Network / Provider
```

### Cardinal Invariants

1. **Non-Authority Rule:** The external adapter must never become a second execution or scheduling authority. OrbitMesh owns the execution contract lifecycle; the external ground network owns physical execution.
2. **Intent $\ne$ Physical Confirmation:**
   $$\text{External Command Intent} \ne \text{Physical Execution Confirmation}$$
   $$\text{OUTBOX DELIVERED} \ne \text{GROUND STATION ACCEPTED}$$
   $$\text{GROUND STATION ACCEPTED} \ne \text{RF TRANSMISSION STARTED}$$
   $$\text{ABORT REQUESTED} \ne \text{RF TRANSMISSION HALTED}$$
3. **Delivery Failure $\ne$ Physical Execution Failure:** A message entering the Dead Letter Queue (`DLQ`) indicates outbound transport exhaustion, **not** that physical pass execution has definitively failed.
4. **Control-Plane Version Boundary:** Routine protocol events, outbox retries, provider polling, and telemetry ingestion maintain schedule version stability ($V_N \to V_N$). Only confirmed scheduling consequences (e.g., `ABORT_CONFIRMED`) advance version ($V_N \to V_{N+1}$) via the serialized Control Plane.

---

## 2. Workstream 5.7.1: Durable Outbound Delivery (Transactional Outbox)

### 2.1 The Atomic Database Unit
To prevent dual-write anomalies and orphaned dispatches, outbound execution messages **must be committed in the exact same database transaction** that creates or updates the reservation execution lifecycle:

$$\begin{pmatrix} \text{Reservation transition: } \text{SCHEDULED} \to \text{EXECUTION\_READY} \\ \text{Dispatch attempt creation: } D_n \text{ (PREPARED)} \\ \text{Outbox message creation: } M_n \text{ (PENDING)} \end{pmatrix} \in \text{ONE DATABASE TRANSACTION}$$

If the process crashes immediately after commit, the outbox worker recovers $M_n$ from the database and delivers it. If the transaction aborts, none of the entities exist.

### 2.2 Database Schema: `outbound_dispatch_messages`
```sql
CREATE TYPE outbox_message_status AS ENUM (
  'PENDING',
  'DELIVERING',
  'DELIVERED',
  'RETRY',
  'DLQ'
);

CREATE TYPE outbox_message_type AS ENUM (
  'STAGE_DISPATCH',
  'ARM_DISPATCH',
  'ABORT_PASS',
  'RF_INHIBIT',
  'STATUS_QUERY'
);

CREATE TABLE outbound_dispatch_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id VARCHAR(64) NOT NULL UNIQUE,
  dispatch_id VARCHAR(64) NOT NULL REFERENCES dispatch_attempts(dispatch_id) ON DELETE RESTRICT,
  reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  provider_id VARCHAR(64) NOT NULL,
  message_type outbox_message_type NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status outbox_message_status NOT NULL DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMP WITH TIME ZONE,
  last_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX outbound_dispatch_pending_idx ON outbound_dispatch_messages (status, next_attempt_at)
  WHERE status IN ('PENDING', 'RETRY');
CREATE INDEX outbound_dispatch_res_idx ON outbound_dispatch_messages (reservation_id);
CREATE INDEX outbound_dispatch_disp_idx ON outbound_dispatch_messages (dispatch_id);
```

### 2.3 Outbox Delivery State Machine
```text
      PENDING
         │
         ▼
    DELIVERING ────(Success)────► DELIVERED
         │
      (Failure / Timeout)
         │
         ▼
       RETRY ────(attempts < max)────► PENDING (backoff delay)
         │
   (attempts >= max)
         │
         ▼
        DLQ  (Alerts operator; preserves attempt state; does NOT fail reservation)
```

---

## 3. Workstream 5.7.2: Vendor-Neutral Provider Adapter Architecture

### 3.1 Pluggable Interface: `IGroundStationProviderAdapter`
```typescript
export interface DispatchContext {
  readonly dispatchId: string;
  readonly attemptNumber: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly providerId: string;
  readonly stationCode: string;
}

export interface CapabilityValidationResult {
  readonly isCompatible: boolean;
  readonly unsupportedBands: string[];
  readonly maxDataRateFeasible: boolean;
  readonly reason?: string;
}

export interface StagedPassReceipt {
  readonly providerDispatchRef: string;
  readonly stagedAt: Date;
  readonly stationStatus: "READY" | "STANDBY" | "BUSY";
  readonly rawProviderResponse: Record<string, unknown>;
}

export interface ArmedPassReceipt {
  readonly armedAt: Date;
  readonly trackingConfigured: boolean;
  readonly rawProviderResponse: Record<string, unknown>;
}

export interface PassAbortReceipt {
  readonly confirmedAt: Date;
  readonly rfCarrierSilenced: boolean;
  readonly rawProviderResponse: Record<string, unknown>;
}

export interface PassStatusSnapshot {
  readonly state: "STAGED" | "ARMED" | "TRACKING" | "TERMINATED" | "UNKNOWN";
  readonly carrierLocked: boolean;
  readonly bytesRecorded: number;
  readonly snrDb?: number;
  readonly lastContactAt?: Date;
}

export interface IGroundStationProviderAdapter {
  readonly providerId: string;

  stagePass(manifest: DispatchManifest, context: DispatchContext): Promise<StagedPassReceipt>;
  armPass(dispatchId: string, context: DispatchContext): Promise<ArmedPassReceipt>;
  abortPass(dispatchId: string, reason: string, context: DispatchContext): Promise<PassAbortReceipt>;
  pollPassStatus?(dispatchId: string, context: DispatchContext): Promise<PassStatusSnapshot>;
  validateCapabilities(stationId: string, requirements: RfRequirements): Promise<CapabilityValidationResult>;
}
```

### 3.2 Provider Timeout & Unknown Outcome Reconciliation
When an outbound call to an external provider times out:
1. OrbitMesh **must not** assume physical rejection or physical success.
2. The dispatch attempt enters `COMMUNICATION_GAP` with `status = RETRY`.
3. The adapter invokes `pollPassStatus(dispatchId, context)`.
4. If polling confirms the provider staged the pass: the attempt transitions to `STAGED_ACK`.
5. If polling confirms provider rejection or pass expiry: the attempt transitions to `REJECTED` or `EXPIRED`.
6. Retrying `stagePass` always transmits the exact same `idempotencyKey` and `dispatchId` to ensure the provider deduplicates the request rather than creating a second physical pass reservation.

---

## 4. Workstream 5.7.3: Two-Layer Authentication & Station Provenance

### 4.1 Separation of Identity vs Authenticity
1. **Layer 1: Client/Transport Identity (mTLS & Bearer Token)**
   - Identifies *which* physical system or station network opened the transport channel.
   - Evaluated at the reverse proxy / TLS termination layer.
2. **Layer 2: Message Authenticity & Content Integrity (HMAC-SHA256)**
   - Proves the payload has not been tampered with and was signed by the designated station's private credential.
   - Formula:
     $$\text{Signature} = \text{HMAC-SHA256}(K_{\text{station}}, \text{dispatchId} \parallel \text{sequenceNumber} \parallel \text{sourceTimestamp} \parallel \text{nonce} \parallel \text{payload})$$
3. **Layer 3: Execution Context & Anti-Replay**
   - The verified message is checked against OrbitMesh's Phase 5.6 execution contract:
     - `dispatchId` must match active reservation dispatch.
     - `sequenceNumber` must follow monotonic progression.
     - `sourceTimestamp` must be within clock skew window ($\pm 5\text{s}$).
     - `idempotencyKey` + `nonce` must be unique across all non-duplicate calls.

### 4.2 Credential Storage & Rotation Schema
```sql
CREATE TYPE station_credential_status AS ENUM ('ACTIVE', 'ROTATING', 'REVOKED');

CREATE TABLE ground_station_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ground_station_id UUID NOT NULL REFERENCES ground_stations(id) ON DELETE CASCADE,
  key_id VARCHAR(64) NOT NULL UNIQUE,
  secret_hash VARCHAR(255) NOT NULL,
  status station_credential_status NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  revoked_at TIMESTAMP WITH TIME ZONE
);
```

---

## 5. Workstream 5.7.4: Operational Safety Interlocks & Circuit Breakers

### 5.1 Command Intent vs Physical Confirmation
An operator emergency abort command must not instantaneously mark physical RF transmission as halted:

$$\begin{pmatrix} \text{Operator initiates abort} \\ \downarrow \\ \text{execution\_interlock} = \text{ABORT\_REQUESTED} \\ \downarrow \\ \text{Adapter transmits out-of-band abort} \end{pmatrix} \quad \ne \quad \begin{pmatrix} \text{Ground station executes abort} \\ \downarrow \\ \text{Provider confirms RF silenced} \\ \downarrow \\ \text{execution\_interlock} = \text{ABORT\_CONFIRMED} \\ \text{execution\_state} = \text{FAILED} \end{pmatrix}$$

### 5.2 Schema: Interlock State on Reservations
```sql
CREATE TYPE execution_interlock_state AS ENUM (
  'NONE',
  'ABORT_REQUESTED',
  'ABORT_CONFIRMED',
  'ABORT_UNCONFIRMED',
  'RF_INHIBIT_REQUESTED',
  'RF_INHIBIT_CONFIRMED',
  'INTERLOCK_FAILED'
);

ALTER TABLE reservations
  ADD COLUMN execution_interlock execution_interlock_state NOT NULL DEFAULT 'NONE',
  ADD COLUMN interlock_requested_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN interlock_confirmed_at TIMESTAMP WITH TIME ZONE;
```

### 5.3 Safety Flow Under Disconnect / Communication Gap
If an abort is commanded while a communication gap exists:
1. `execution_interlock` transitions to `ABORT_REQUESTED`.
2. Outbox worker aggressively retries the physical abort command.
3. Operator UI displays an amber warning: `ABORT UNCONFIRMED - LINK SILENT`.
4. If network timeout or watchdog triggers before station acknowledgment, the interlock transitions to `ABORT_UNCONFIRMED` (outcome unknown). A watchdog triggers safety escalation but **never manufactures physical confirmation** that RF transmission has halted.
5. Only when physical confirmation is acknowledged by the station does the interlock transition to `ABORT_CONFIRMED`.
6. Only upon authoritative scheduling consequences does the Event Control Plane advance the schedule version ($V_N \to V_{N+1}$) to safely release ground antenna locks and trigger recovery.

---

## 6. Formal Acceptance Gate (19 Scenarios: A through S)

### Outbox & Durable Delivery
- **A. Crash before DB commit:** Transaction rolls back; neither reservation transition nor outbox message exists.
- **B. Crash after DB commit / before delivery:** Outbox message survives in `PENDING` state; recovered by outbox worker upon restart and delivered.
- **C. Provider timeout after accepted stage:** Worker retries with identical `idempotencyKey` and `dispatchId`; provider returns idempotent response without duplicating physical reservation.

### Provider Adapter & Protocol Perimeter
- **D. Provider accepts stage:** Normal `stagePass` returns `STAGED_ACK`; dispatch attempt state transitions cleanly.
- **E. Provider rejects stage:** Station hardware error returns canonical rejection; dispatch attempt transitions to `REJECTED`.
- **F. Provider times out during stage:** Dispatch attempt enters `COMMUNICATION_GAP`; background status polling resolves outcome without premature abort.
- **G. Provider returns duplicate response:** Adapter reuses active dispatch identity; zero state machine disturbance.

### Authentication, Security & Anti-Replay
- **H. Valid authenticated telemetry:** Authenticated via mTLS and valid HMAC signature; processed cleanly.
- **I. Invalid HMAC signature:** Telemetry rejected with HTTP `401/403`; zero database mutation.
- **J. Revoked station credential:** Telemetry signed by revoked `key_id` rejected; audit alert logged.
- **K. Replay of previously authenticated packet:** Identical `idempotencyKey` returns cached receipt; replayed packet with forged sequence rejected.

### Operational Safety Interlocks
- **L. Abort commanded & successfully delivered:** Interlock transitions `ABORT_REQUESTED` $\to$ `ABORT_CONFIRMED`; reservation transitions to `FAILED` (`EXECUTION_ABORTED`); schedule version increments ($V_N \to V_{N+1}$).
- **M. Abort command times out (ambiguity):** Interlock transitions to `ABORT_UNCONFIRMED`; does not claim physical RF halt; operator alerted.
- **N. Abort during active communication gap:** Interlock records `ABORT_REQUESTED`; unresolved warning exposed to operator console.
- **O. RF inhibit commanded:** Provider confirms physical carrier inhibit independently from reservation execution failure.

### Cross-Layer & Edge Cases
- **P. Outbox retry while attempt is stale:** Outbox worker detects newer active dispatch ($D_2$ active); drops stale $D_1$ delivery with `STALE_OUTBOX_DISCARDED`.
- **Q. Provider response arrives after manual reservation cancellation:** Provider response ignored/quarantined; cancelled reservation remains `CANCELLED`.
- **R. Duplicate provider acknowledgement:** Duplicate `STAGED_ACK` or `ARMED_ACK` processed idempotently with zero duplicate state mutation.
- **S. Ground provider process restart:** Reconciliation poll restores station link health without creating redundant dispatch attempts.

---

## 7. Versioning & Control Plane Invariant Gate

The Control Plane remains the single writer for scheduling mutations. The general invariant is:

$$\text{Routine Execution Activity} \implies V_N \longrightarrow V_N$$
$$\text{Authoritative Scheduling Consequence} \implies V_N \longrightarrow V_{N+1} \quad \text{(via Control Plane)}$$

| Operation | Expected Version Shift | Reason |
|---|---|---|
| Outbox delivery retry | $V_N \longrightarrow V_N$ | Internal transport retry |
| Outbox message to DLQ | $V_N \longrightarrow V_N$ | Delivery failure $\ne$ physical pass failure |
| Provider `STAGED_ACK` | $V_N \longrightarrow V_N$ | Routine handshake |
| Provider `ARMED` | $V_N \longrightarrow V_N$ | Handshake complete |
| Routine telemetry packet | $V_N \longrightarrow V_N$ | Telemetry actuals update |
| `ABORT_REQUESTED` | $V_N \longrightarrow V_N$ | Command sent, unconfirmed |
| `ABORT_UNCONFIRMED` | $V_N \longrightarrow V_N$ | Unresolved outcome; safety escalation |
| `ABORT_CONFIRMED` | $V_N \longrightarrow V_{N+1}$ | Physical execution terminated; releases antenna locks |
| Authoritative Hardware Failure | $V_N \longrightarrow V_{N+1}$ | Station offline; triggers rescue/replan |
| Authoritative Pass Shortfall / Failure | $V_N \longrightarrow V_{N+1}$ | Target deficit; triggers replanning |
| Nominal Pass Completion | $V_N \longrightarrow V_N$ | Target met, normal cycle |

