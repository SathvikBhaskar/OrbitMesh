# Phase 5.8: Execution Provider Certification & Real-Protocol Integration Specification

**Status:** APPROVED FOR SPECIFICATION  
**Predecessor Baseline:** Phase 5.7 (`phase-5.7-accepted`, commit `bfc5da7`) — Strictly Frozen  
**Core Invariant:** Phase 5.8 validates and connects external execution providers; it **does not redefine OrbitMesh scheduling or execution semantics**.

---

## 1. Architectural Overview & Context

OrbitMesh Phase 5.7 established a durable, authenticated, and fault-tolerant execution perimeter:
- **Durable Delivery:** Transactional outbox pattern guaranteeing at-least-once dispatch delivery with dead-letter queue (DLQ) containment.
- **Provider Perimeter:** Pluggable adapter abstraction with explicit `DispatchContext` and status reconciliation over ambiguous transport outcomes.
- **Two-Layer Provenance:** Transport-level identity (mTLS) coupled with canonical HMAC-SHA256 message signing, sequence ordering, clock skew enforcement, and anti-replay nonce tracking.
- **Safety Interlocks:** Absolute separation of command intent (`ABORT_REQUESTED`) from physical carrier silencing confirmation (`ABORT_CONFIRMED`), watchdog-guarded ambiguous link handling (`ABORT_UNCONFIRMED`), and schedule version advancement ($V_N \to V_{N+1}$) restricted strictly to authoritative Control Plane preemption consequences.

Phase 5.8 moves OrbitMesh from a **validated perimeter model** to an **experimentally certified, multi-protocol execution system**.

```text
       ┌────────────────────────────────────────────────────────┐
       │             FROZEN ORBITMESH CORE ARCHITECTURE         │
       │                                                        │
       │   Phase 4: SGP4 Orbit Propagation & Multi-Station Core  │
       │   Phase 5.1–5.4: Event Control Plane & Replanning       │
       │   Phase 5.5: Canonical Execution Contract               │
       │   Phase 5.6: Fault-Tolerant Ground Adapter Contract    │
       │   Phase 5.7: Durable Outbox, Provenance & Safety Locks  │
       └───────────────────────────┬────────────────────────────┘
                                   │
                           IGroundStationProviderAdapter
                                   │
       ════════════════════════════╪════════════════════════════
                     PHASE 5.8 INTEGRATION HORIZON
       ════════════════════════════╪════════════════════════════
                                   ▼
       ┌────────────────────────────────────────────────────────┐
       │ Workstream 5.8.1: Provider Compliance & Certification  │
       │ The Authoritative Arbiter between Canonical Contract    │
       │ and Any External Provider Implementation                │
       └───────┬───────────────────┬───────────────────┬────────┘
               │                   │                   │
               ▼                   ▼                   ▼
       ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
       │   Layer A:    │   │   Layer B:    │   │   Layer C:    │
       │   Semantic    │   │  Distributed  │   │  Security &   │
       │  Conformance  │   │  Conformance  │   │  Provenance   │
       └───────┬───────┘   └───────┬───────┘   └───────┬───────┘
               │                   │                   │
               └───────────────────┼───────────────────┘
                                   │
                                   ▼
       ┌────────────────────────────────────────────────────────┐
       │   Layer D: Safety & Interlock Conformance              │
       └───────────────────────────┬────────────────────────────┘
                                   │ PASS (Certified)
                                   ▼
       ┌────────────────────────────────────────────────────────┐
       │ Workstream 5.8.2: Protocol-Specific Adapters           │
       │ ├── 5.8.2-A: Commercial Ground API (AWS GS Model)      │
       │ └── 5.8.2-B: CCSDS Space Link Extension (SLE RAF/RCF)  │
       └───────────────────────────┬────────────────────────────┘
                                   │
       ┌───────────────────────────┴────────────────────────────┐
       │ Workstream 5.8.3: Production Transport Security        │
       │ - Operational X.509 mTLS with CA Trust & CRL/OCSP       │
       │ - Key Custody & KMS/Vault Automated Rotation Lifecycle │
       └───────────────────────────┬────────────────────────────┘
                                   │
       ┌───────────────────────────┴────────────────────────────┐
       │ Workstream 5.8.4: Virtual Ground Station (VGS) / HIL   │
       │ - Level 1: Digital Baseband Frame Simulation           │
       │ - Level 2: SDR & RF Channel Emulation (Doppler/Loss)   │
       │ - Level 3: Physical Hardware / Attenuated RF Bench     │
       └────────────────────────────────────────────────────────┘
```

---

## 2. Workstream 5.8.1: Provider Compliance & Certification Harness

### 2.1 Principle of the Certification Arbiter
Before any external provider adapter (mock, commercial, or CCSDS SLE) is eligible to receive production dispatch messages, it must execute against and pass the automated **OrbitMesh Provider Compliance Harness**. The harness acts as an authoritative, third-party validation suite asserting four orthogonal conformance layers.

```text
                           Canonical Contract
                                   │
                         Certification Harness
                         /         |         \
                        /          |          \
                  Mock Adapter   AWS Adapter   SLE Adapter
                  (Passes)       (Passes)      (Passes)
```

### 2.2 The Four Certification Layers

#### Layer A: Semantic Conformance
Validates that provider primitives map directly and bijectively into OrbitMesh's Phase 5.6/5.7 canonical handshake lifecycle:
1. `stagePass(context)` maps unambiguously to `STAGED_ACK` upon provider acceptance or `REJECTED` upon resource rejection.
2. `armPass(dispatchId, context)` maps to `ARMED` and advances the reservation to `DISPATCHED`.
3. `pollPassStatus(dispatchId, context)` retrieves canonical pass status (`UNKNOWN`, `STAGED`, `ARMED`, `COMPLETED`, `FAILED`, `EXPIRED`).
4. `abortPass(dispatchId, reason, context)` initiates out-of-band carrier silencing.

#### Layer B: Distributed-Systems Conformance
Validates resilience against real network and provider anomalies:
1. **Ambiguous Staging Timeout:** When `stagePass` times out, a subsequent status poll or retry using the identical `idempotencyKey` and `dispatchId` recovers the reservation without creating duplicate physical passes.
2. **Duplicate Request Idempotency:** Duplicate delivery of identical requests yields zero state mutation and returns existing receipts.
3. **Delayed/Out-of-Order Responses:** Out-of-order execution telemetry frames are detected and buffered or reported as sequence gaps without corrupting monotonic byte counters.
4. **Provider Restart & Link Recovery:** Periodic status polling restores disconnected provider sessions without repeating physical dispatches.

#### Layer C: Security & Provenance Conformance
Validates that the provider enforces and complies with OrbitMesh's two-layer authentication model:
1. **Transport Identity:** Transport requests lacking valid client identity are rejected.
2. **Message Integrity & HMAC-SHA256:** Payloads with altered bytes, incorrect key IDs, or corrupted signatures are immediately rejected.
3. **Anti-Replay Nonce & Monotonic Sequences:** Replayed nonces and retrograde sequence numbers are dropped with audit logs.
4. **Clock Skew Enforcement:** Telemetry frames with timestamps exceeding $\pm 5000\,\text{ms}$ are discarded.
5. **Credential Lifecycle Transitions:** Credentials in `ACTIVE` and `ROTATING` states authenticate; `REVOKED` credentials immediately reject all traffic.

#### Layer D: Safety & Interlock Conformance
Validates that safety overrides are strictly observed and never falsified:
1. **Command Intent Separation:** Dispatched abort requests set `execution_interlock = ABORT_REQUESTED` but do not alter physical execution state until explicitly acknowledged.
2. **Confirmed Silencing:** When the provider verifies RF carrier shutdown, the interlock transitions to `ABORT_CONFIRMED`, fails the reservation with `EXECUTION_ABORTED`, and invokes the Control Plane.
3. **Ambiguity & Silent Links:** When communication drops during an abort attempt, the interlock enters `ABORT_UNCONFIRMED`. **Watchdogs or timeouts never manufacture false confirmation that RF has ceased.**
4. **Independent RF Carrier Inhibit:** Regulatory carrier inhibit commands (`RF_INHIBIT_REQUESTED` $\to$ `RF_INHIBIT_CONFIRMED`) silence physical RF without mutating task execution records to physical failures.

### 2.3 Certification Receipt Artifact
Upon successful execution of all four layers, the harness outputs an auditable, cryptographically signed certification receipt:
```typescript
export interface ProviderCertificationReceipt {
  readonly providerId: string;
  readonly protocolType: "COMMERCIAL_API" | "CCSDS_SLE" | "SIMULATED_MOCK";
  readonly certifiedAt: Date;
  readonly testResults: {
    readonly semanticConformance: boolean;
    readonly distributedSystemsConformance: boolean;
    readonly securityConformance: boolean;
    readonly safetyConformance: boolean;
  };
  readonly totalAssertions: number;
  readonly signature: string;
}
```

---

## 3. Workstream 5.8.2: Protocol-Specific Adapters

### 3.1 Workstream 5.8.2-A: Commercial Ground Provider Adapter (AWS Ground Station Model)
The commercial adapter provides a concrete bridge between OrbitMesh's internal outbox and an external, REST/JSON-driven commercial ground station API:

1. **Contact Model Mapping:**
   - Commercial states: `SCHEDULING`, `SCHEDULED`, `PREPASS`, `PASS`, `POSTPASS`, `COMPLETED`, `FAILED`.
   - OrbitMesh mapping:
     - `SCHEDULING` $\to$ `PREPARED`
     - `SCHEDULED` $\to$ `STAGED_ACK`
     - `PREPASS` / `PASS` $\to$ `ARMED` $\to$ `DISPATCHED`
     - Pass In-Flight $\to$ `IN_PROGRESS`
     - `POSTPASS` / `COMPLETED` $\to$ `COMPLETED` / `PARTIAL`
     - `FAILED` $\to$ `FAILED`
2. **Client-Token Idempotency:**
   - AWS Ground Station provides client-token semantics for contact mutations. OrbitMesh's `context.idempotencyKey` maps 1:1 to the provider's `clientToken`, preventing duplicate external bookings.
3. **Visibility Window Tracking:**
   - Preserves start, end, and prepass/postpass acquisition margins without modifying canonical reservation times.

### 3.2 Workstream 5.8.2-B: CCSDS Space Link Extension (SLE) Adapter
The standards-oriented cross-support integration target speaks the CCSDS Space Link Extension (SLE) protocol family.

#### Architectural Separation of Concerns
To prevent the SLE adapter from becoming an unwieldy protocol stack, responsibilities are strictly partitioned:

```text
┌────────────────────────────────────────────────────────┐
│                   SLE Adapter Domain                   │
│ - SLE Service Semantics (RAF / RCF / CLTU)             │
│ - PDU Encoding / Decoding (ASN.1 PER/BER)              │
│ - Session Lifecycle: BIND / UNBIND / START / STOP       │
│ - Provider State Mapping (UNBOUND -> BINDING -> BOUND  │
│   -> ACTIVE)                                           │
└───────────────────────────┬────────────────────────────┘
                            │ Space-Link Frames
                            ▼
┌────────────────────────────────────────────────────────┐
│               Space-Link / RF Baseband Domain          │
│ - CADU / Transfer Frames (CCSDS 132.0-B-3)             │
│ - Coding & Synchronization (CRC, Reed-Solomon, LDPC)   │
│ - Modulation & Demodulation (QPSK, BPSK)               │
│ - RF Physical Layer / Carrier Acquisition              │
└────────────────────────────────────────────────────────┘
```

1. **Applicable CCSDS Standards:**
   - **CCSDS 911.1-B-5 (July 2023):** Space Link Extension — Return All Frames (RAF) Service.
   - **CCSDS 911.2-B-4 (July 2023):** Space Link Extension — Return Channel Frames (RCF) Service.
   - **CCSDS 913.1-B-2:** SLE Internet Protocol for Transfer Services.
2. **PDU Structure & Session Management:**
   - Implements ASN.1-defined PDUs: `SleBind`, `SleBindReturn`, `SleUnbind`, `RafStart`, `RafStop`, `RafTransferData`.
   - Translates OrbitMesh `stagePass` into SLE `BIND` + `START` sequence.
   - Translates OrbitMesh `abortPass` into SLE `STOP` + `UNBIND` out-of-band sequence.

---

## 4. Workstream 5.8.3: Production Transport Security & Key Custody

This workstream advances from application-level signatures to enterprise-grade operational security and key custody:

```text
Layer 1: Transport Identity (mTLS)
   - X.509 Mutual Certificate Authentication
   - Root & Intermediate CA Trust Chain Validation
   - Real-time Revocation via CRL or OCSP Stapling

Layer 2: Message Authenticity & Content Integrity (HMAC-SHA256)
   - Canonical Field Serialized Payload Signing
   - KMS / Vault-backed Secret Storage
   - Automated Dual-Key Rotation Grace Period

Layer 3: Attempt Validity & Execution Context
   - dispatchId + Sequence Progression + Nonce Cache
   - Bounded Clock Skew (±5000ms)
```

1. **Certificate Verification Engine:**
   - Strict X.509 chain of trust checking with hostname and SAN verification.
   - Rejection of expired, self-signed (untrusted), or revoked station certificates.
2. **Key Custody Architecture:**
   - Station private pre-shared secrets stored encrypted with master envelope encryption.
   - Dual-key overlapping window during credential rotation: when a key transitions from `ACTIVE` to `ROTATING`, telemetry signed with both old and new keys is accepted for a configurable grace window (e.g., 24 hours), before old key transition to `REVOKED`.

---

## 5. Workstream 5.8.4: Virtual Ground Station (VGS) & Physical Simulation (HIL)

### 5.1 Strict Classification of Physical Simulation Levels
To ensure technical accuracy, physical simulation is explicitly categorized into three distinct, non-conflated validation levels:

| Level | Classification | Physical Equipment | Target Invariants |
|:---:|---|---|---|
| **Level 1** | **Digital Baseband Simulator** | Pure software / bitstream emulator | Validates CADU/frame extraction, bitstream framing, sequence counter jumps, packet loss, and simulated carrier drops. |
| **Level 2** | **SDR & RF Channel Emulator** | Software-Defined Radio (SDR) with simulated RF channel | Validates carrier frequency tracking, Doppler shift compensation, signal-to-noise ratio (SNR) degradation, and baseband lock states. |
| **Level 3** | **RF Hardware in the Loop (HIL)** | Physical transceivers, attenuators, baseband modems | Validates true physical carrier cut-off power ($\le -120\,\text{dBm}$), amplifier blanking, and physical relay disconnects. |

### 5.2 Baseband State Engine (Level 1 & 2)
```text
           [AOS Approaching]
                  │
                  ▼
         ┌───────────────────┐
         │ CARRIER_ACQUIRED  │
         └────────┬──────────┘
                  │ Bit Sync Locked
                  ▼
         ┌───────────────────┐
         │  BIT_SYNC_LOCKED  │
         └────────┬──────────┘
                  │ Frame Sync Marker Locked (0x1ACFFC1D)
                  ▼
         ┌───────────────────┐
         │ FRAME_SYNC_LOCKED │ ──> Ingest Telemetry Frames
         └────────┬──────────┘
                  │
                  ├──> Operator Abort / RF Inhibit Confirmed
                  │         ↓
                  └──> CARRIER_LOST (RF silenced instantaneously)
```

---

## 6. Phase 5.8 Acceptance Dimensions & Certification Gate

A provider integration is approved when it passes all four certification dimensions:

| Dimension | Primary Objective | Acceptance Scenario |
|---|---|---|
| **1. Contract Conformance** | Does provider obey OrbitMesh execution semantics? | Full Layer A & B compliance pass in certification harness. |
| **2. Protocol Conformance** | Does protocol adapter correctly encode/decode and map state? | Clean round-trip PDU serialization and state mapping (AWS Ground Station REST or CCSDS SLE). |
| **3. Security Conformance** | Can unauthorized, replayed, or revoked traffic be rejected? | Full Layer C compliance pass with X.509 mTLS and key custody rotation verification. |
| **4. Physical Simulation** | Does the execution contract hold under realistic baseband dynamics? | Baseband simulator verifies carrier lock, frame acquisition, and physical silencing under abort/inhibit. |

---

## 7. Implementation Sequence

The workstreams will be delivered in the following strict order:
1. **Workstream 5.8.1: Provider Compliance & Certification Test Harness**
2. **Workstream 5.8.2-A: Commercial Ground Provider Adapter (AWS Ground Station Model)**
3. **Workstream 5.8.2-B: CCSDS Space Link Extension (SLE RAF/RCF) Adapter**
4. **Workstream 5.8.3: Production Transport Security & Key Custody**
5. **Workstream 5.8.4: Virtual Ground Station (VGS) / Baseband Simulation (Level 1/2 HIL)**
6. **Phase 5.8 Full Certification Gate & Regression Baseline**
