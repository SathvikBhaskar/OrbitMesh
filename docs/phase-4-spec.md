# OrbitMesh Phase 4 Technical Specification & Acceptance Gates

**Status:** APPROVED FOR IMPLEMENTATION  
**Baseline Git Checkpoint:** `phase-3.7.8-accepted` (Commit `5166301`)  
**Parent Specification:** `PROJECT_SPEC.md` §32

---

## 1. Architectural Invariants (Inherited from Phase 3)

The following invariants MUST remain green and untouched across every Phase 4 subphase:

1. **Frozen MetaScheduler:** Legacy scheduler implementation remains untouched.
2. **`MANUAL + LOCKED` Invariance:** Locked reservations are hard constraints; never pre-empted, moved, or deleted by any automated policy.
3. **Dry-Run Preview:** `POST /api/scheduler/preview` is strictly non-mutating (zero database writes, zero version increments).
4. **Authoritative Constraint Validator:** Physical geometry, window bounds, task deadlines, and station capabilities are verified strictly by backend `ConstraintValidationService`.
5. **Optimistic Concurrency:** Stale version commits produce explicit HTTP `409 SCHEDULE_VERSION_CONFLICT`.
6. **Immutable Audit Trail:** Append-only logging of all state transitions and reservations.
7. **Research Isolation:** Pilot/Lab experimental runners remain decoupled from production scheduling APIs.
8. **Frontend Boundary:** React UI is presentation-only; no physical or business constraint authority exists on the client.
9. **Regression Gate:** **All Phase 3 tests (59 backend + 8 frontend) must pass at every subphase gate.**

---

## 2. Pipeline Architecture: Hard Constraints Before Scoring

Under no circumstances may hard physical, temporal, or capability constraints be converted into soft scoring terms. A candidate cannot be given a high score that "overcomes" an infeasibility.

```
       ┌──────────────────────────────┐
       │   1. Candidate Generator     │
       │ (Satellites × Windows × Tasks)│
       └──────────────┬───────────────┘
                      │
                      ▼
       ┌──────────────────────────────┐
       │ 2. Hard Constraint Validator │
       │ (ConstraintValidationService)│
       │ - Window Time Bounds         │
       │ - Satellite Conflict Check   │
       │ - Station Channel Capacity   │
       │ - RF Band Compatibility      │
       │ - Min Data Rate Check        │
       │ - Deadline Viability         │
       │ - Locked Reservation Clashes │
       └──────────────┬───────────────┘
                      │
               Feasible Candidates Only
                      │
                      ▼
       ┌──────────────────────────────┐
       │ 3. Policy & Scoring Engine   │
       │ (FCFS / Priority / Hybrid)   │
       │ - Urgency (Slack Time)       │
       │ - Priority Weighting         │
       │ - Elevation Profile Quality  │
       │ - Multi-Station Packing      │
       └──────────────┬───────────────┘
                      │
                      ▼
       ┌──────────────────────────────┐
       │ 4. Deterministic Allocation  │
       │ (Preview Proposal / Commit)  │
       └──────────────────────────────┘
```

---

## 3. Subphase Breakdown & Deterministic Acceptance Gates

### Phase 4.1 — Ground-Station Hardware Capabilities & RF Compatibility

#### Domain Model Additions
* **`ground_stations`**:
  * `supported_frequency_bands`: `text[]` (e.g., `['S_BAND', 'X_BAND', 'KA_BAND', 'UHF']`)
  * `max_concurrent_contacts`: `integer` (channel capacity, default `1`)
  * `max_data_rate_mbps`: `numeric(8, 2)` (optional maximum link bandwidth)
* **`mission_tasks`**:
  * `required_frequency_band`: `text` (default `'S_BAND'`)
  * `min_data_rate_mbps`: `numeric(8, 2)` (optional minimum required rate)

#### Authoritative Validator Rule
`ConstraintValidationService.validateReservation(...)` checks:
1. `task.requiredFrequencyBand` $\in$ `station.supportedFrequencyBands` $\rightarrow$ if not, `INCOMPATIBLE_FREQUENCY_BAND`.
2. `task.minDataRateMbps` $\le$ `station.maxDataRateMbps` (if specified) $\rightarrow$ if not, `INSUFFICIENT_STATION_DATA_RATE`.
3. Simultaneous reservations on station at time $t$ $< \text{maxConcurrentContacts} \rightarrow$ if not, `GROUND_STATION_CAPACITY_EXCEEDED`.

#### Acceptance Gate 4.1
- [ ] Task requiring `X_BAND` on an `S_BAND`-only station is rejected with 422 `INCOMPATIBLE_FREQUENCY_BAND`.
- [ ] Overlapping reservation exceeding `maxConcurrentContacts` is rejected with 422 `GROUND_STATION_CAPACITY_EXCEEDED`.
- [ ] Compatible band & capacity passes validation.
- [ ] All 59 Phase 3 backend tests remain passing.

---

### Phase 4.2 — Deadline Urgency & Slack-Time Dynamics

#### Formal Urgency Metrics
For candidate window $W = [AOS_W, LOS_W]$ and task $T$ with duration $D_T$ and deadline $DL_T$:
* **Slack Time:**
  $$\text{Slack}(T, W) = DL_T - (AOS_W + D_T)$$
* **Urgency Ratio:**
  $$\text{UrgencyRatio}(T, t_{\text{ref}}) = \frac{D_T}{\max(1, DL_T - t_{\text{ref}})}$$

#### Deterministic Edge Case Handling
1. **Deadline Exceeded ($DL_T < \text{Now}$ or $DL_T < AOS_W + D_T$):** Task marked `UNSCHEDULED` with code `DEADLINE_EXCEEDED`.
2. **Negative Slack:** Infeasible on window $W$; discarded by Hard Constraint Validator.
3. **No Feasible Future Windows:** Marked `UNSCHEDULED` with code `NO_FEASIBLE_WINDOW`.
4. **Equal Urgency Tie-Breaker:** Resolved deterministically by `priority DESC`, then `createdAt ASC`, then `id ASC`.

#### Deterministic Fixture Test (Controlled Contention)
* **Fixed Setup:**
  * Window $W_1$: duration 10 min.
  * Task A (High Priority, Ample Slack): priority = 10, duration = 6 min, deadline = +24 hr.
  * Task B (Low Priority, Critical Slack): priority = 2, duration = 6 min, deadline = +15 min.
  * Satellite visibility: Task A has another feasible window $W_2$ at +2 hr. Task B has **no other window** before its deadline.
* **Expected Result:**
  * Urgency-aware policy allocates $W_1$ to Task B (preventing a permanent deadline miss).
  * Task A is scheduled in $W_2$.
  * Zero dropped high-priority tasks; zero missed deadlines.

#### Acceptance Gate 4.2
- [ ] Deterministic controlled contention test passes.
- [ ] Explicit error codes verified: `DEADLINE_EXCEEDED`, `NO_FEASIBLE_WINDOW`, `INSUFFICIENT_SLACK`.
- [ ] All Phase 3 regression tests remain passing.

---

### Phase 4.3 — Hybrid Scoring Engine & Benchmarked Policy Suite

#### Standardized Metric Definitions
Every scheduler policy evaluation must emit the following uniform metrics object:
```typescript
interface PolicyBenchmarkMetrics {
  scheduledTaskCount: number;
  unscheduledTaskCount: number;
  weightedPriorityValue: number;      // sum of priority of all scheduled tasks
  deadlineSuccessRate: number;        // (scheduledOnTime / totalTasks) * 100
  totalScheduledDurationSeconds: number;
  stationUtilizationPercent: number;  // (occupiedSeconds / totalWindowSeconds) * 100
  satelliteUtilizationPercent: number;
  deadlineMissCount: number;
  averageSlackSecondsAtAllocation: number;
}
```

#### Deterministic Fixed Benchmark Fixture
A version-controlled benchmark fixture (`backend/src/fixtures/phase4-benchmark-workload.json`) containing:
* 5 satellites (LEO)
* 4 ground stations (varied bands: S-band, X-band, multi-channel)
* 50 contact windows
* 60 competing mission tasks with calibrated contention regimes (critical slack, high-priority, band-restricted)

#### Deterministic Policy Comparison Gate
Run the fixed benchmark across all three policies and assert exact deterministic outcomes:
```text
FCFS Policy:
  - Schedules by arrival/deadline order without priority pre-emption.
  - Generates baseline metric profile F_metrics.

PRIORITY Policy:
  - Schedules strictly by priority DESC, deadline ASC.
  - Maximizes weightedPriorityValue on first windows; exhibits higher deadlineMissCount for urgent low-priority tasks.
  - Generates metric profile P_metrics.

HYBRID Policy:
  - Evaluates Score = w_prio * NormPriority + w_urg * NormUrgency + w_qual * NormElevation.
  - Resolves critical slack tasks without sacrificing high-value tasks.
  - Generates metric profile H_metrics.
```

#### Acceptance Gate 4.3
- [ ] All three policies run against the fixed benchmark fixture reproducibly (100% deterministic, no random seeds in test).
- [ ] Emits all 8 standardized metrics cleanly.
- [ ] All Phase 3 regression tests remain passing.

---

### Phase 4.4 — Multi-Station Allocation & Overlapping Pass Disambiguation

#### Scope
* When a satellite pass simultaneously covers multiple ground stations (e.g., overlapping footprints across South Asia / Europe), allocate tasks across available stations without double-booking either:
  * The satellite (cannot transmit simultaneously to two stations on the same transceiver).
  * The ground station (cannot exceed its `maxConcurrentContacts`).
* Multi-task packing: if a contact window is 15 minutes, pack multiple 3-minute tasks with adequate guard bands (e.g. 30s re-pointing/handshake time).

#### Acceptance Gate 4.4
- [ ] Overlapping visibility fixture: Sat-1 visible from Station A and Station B simultaneously. Two tasks assigned: Task 1 to Station A, Task 2 to Station B at non-overlapping timestamps.
- [ ] Intra-satellite contact overlap constraint strictly enforced: no two reservations for the same satellite overlap in time regardless of station.
- [ ] Multi-task packing within single window packs sequentially without timestamp overlap.
- [ ] All Phase 3 regression tests remain passing.

---

### Phase 4.5 — Operations UI Integration

#### Backend Contract
`POST /api/scheduler/preview` and `POST /api/scheduler/commit` accept optional `policy`:
```json
{
  "scheduleVersion": 52,
  "policy": "HYBRID" | "PRIORITY" | "FCFS"
}
```
The response returns:
```json
{
  "policy": "HYBRID",
  "scheduleVersion": 52,
  "proposedReservations": [...],
  "unscheduled": [...],
  "metrics": {
    "scheduledTaskCount": 42,
    "weightedPriorityValue": 310,
    "deadlineSuccessRate": 95.4,
    "stationUtilizationPercent": 78.2
  },
  "scoreBreakdowns": [...]
}
```

#### UI Capabilities
1. **Policy Switcher:** Operator can select policy (`FCFS`, `Priority`, `Hybrid`) in the Schedule Timeline toolbar.
2. **Station Capability Badges:** Display supported RF bands (`[S]`, `[X]`, `[Ka]`) and channel limits in ground station cards and timeline tracks.
3. **Metric Comparison Cards:** Display live proposal metrics (Success Rate, Weighted Value, Utilization) in the preview banner.
4. **Zero Client Authority:** React UI does not compute scores or filter candidates; it strictly renders backend API outputs.

#### Acceptance Gate 4.5
- [ ] Operator can toggle policies in UI, receive updated proposals, and inspect score breakdowns.
- [ ] Committing with selected policy records policy name in `schedule_audit_log`.
- [ ] All frontend unit tests pass (`npm test`).

---

### Phase 4.6 — End-to-End Acceptance Gate & Phase 4 Sign-Off

#### Comprehensive Gate Checklist
1. All subphase tests (4.1 through 4.5) passing.
2. Full Phase 3 regression test suite (59 backend + 8 frontend tests) passing.
3. Frontend & Backend clean production builds (`npm run build`).
4. Automated reproducible acceptance script verifying:
   - RF band rejection (422)
   - Urgency-based allocation under contention
   - Multi-station conflict prevention
   - Policy-driven commit with audit tracking
   - Invariance of `MANUAL + LOCKED` reservations
5. Formal Phase 4 acceptance report generated with reproducible data.
