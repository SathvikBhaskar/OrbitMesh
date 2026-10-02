# Scheduling-Impact Research Design (v4)
## How Orbital-Data Updates Propagate Into Mission-Schedule Disruption

**Status:** Design only — no production code changes.  
**Revision:** v4, incorporating final methodological review corrections.  
**Frozen benchmark:** Phase 5 holdout (2,160 runs, 54.1% Oracle accuracy) is untouched.  
**Date:** 2026-08-16

---

## 1. Research Question

> **When a satellite's orbital elements are updated, which subset of an existing mission schedule becomes infeasible, and how much computation is required to restore schedule validity compared to full regeneration?**

Three sub-problems:

**RQ1 — Propagation:** Given a new TLE for satellite *s*, which contact windows change by more than a threshold δ when both TLEs are propagated over the same 24-hour horizon?

**RQ2 — Impact:** Of the reservations in the baseline schedule, what fraction become infeasible — meaning no new contact window for the same satellite/station fully contains the allocated interval? How does this relate to the concentration of scheduled work on updated satellites?

**RQ3 — Recovery:** Can a targeted rescheduling strategy — one that reschedules only affected tasks — approach full-regeneration schedule quality while requiring substantially less computation, and for what range of invalidation rates does this hold?

---

## 2. Hypotheses

### H1 — Empirical Locality of Window Change

> We hypothesize that real CelesTrak TLE updates produce sparse changes in the resulting contact-window set. The magnitude and temporal distribution of those changes must be measured empirically via Stage B characterisation.

**Rationale:** Sparsity is plausible because TLE refitting for healthy, non-maneuvering satellites typically corrects small accumulated prediction errors rather than reflecting large discontinuous state changes. However, the relationship between orbital-state divergence and contact-window change is not assumed in advance — it is the primary empirical question of Stage B.

**No assumption is made about the temporal distribution of window changes across the 24-hour horizon.** SGP4 prediction error accumulates nonlinearly with propagation time and the relationship between orbital perturbation magnitude and window-shift timing must be observed, not inferred.

**Falsifiable:** H1 is falsified if the median changed-window fraction `CWF` exceeds 0.50 across the empirically supported orbital-divergence distribution. (Divergence bins will be defined by observed quantiles in Stage B rather than arbitrary preset bounds).

---

### H2 — Reservation invalidation is substantially smaller than satellite reservation exposure for typical orbital updates.

> The reservation invalidation rate IR is bounded above by the Satellite Reservation Exposure (SRE). The scientific question is not simply "how many satellites changed?" but "when X% of the schedule is exposed to an orbital update, does substantially less than X% actually become invalid?"

**Structural bound:**

```
IR ≤ SRE

where  SRE = |{ r ∈ S₀ : r.satelliteId ∈ U }| / |S₀|
```

This is the true structural upper bound. A single updated satellite that holds 80% of the scheduled reservations can produce IR approaching 0.80, even if only 1 of 100 satellites changed.

SRE is a measurable quantity providing a conservative upper bound on reservation exposure and can be evaluated as a pre-screening signal for targeted recovery.

**Falsifiable:** We model the relationship using a regression:
```
IR_i = β₀ + β₁SRE_i + β₂CWF_i + β₃μ_pos,i + u_class + ε_i
```
We also measure the ratio `ρ = IR / SRE` (reporting median, P25/P75, P95, and CI). H2 is falsified if SRE alone is not a useful predictor of IR in the regression model, or if the median ρ is close to 1.0 (indicating the bound is perfectly tight and invalidation is not sparse relative to exposure).

---

### H3 — Favorable Quality–Cost Frontier for Targeted Rescheduling

> Targeted rescheduling exhibits a favorable quality–cost frontier: as reservation invalidation rate (IR) decreases, targeted recovery approaches full-regeneration schedule quality while requiring substantially less computation.

**Candidate practical thresholds (to be empirically evaluated, not assumed):**

> *"TARGETED achieves ≥ 95% of FULL's PWS at SR_compute ≥ 5× when IR < 25%."*

These numbers — 95%, 5×, 25% — are candidate thresholds that the experiment will confirm, refute, or replace with measured values. They are not theoretical claims and do not define the hypothesis. The hypothesis is the shape of the frontier; the specific numbers come from the data.

**Rationale:** The analogue in the incremental window-regeneration benchmark (Step 5.2) was ~51× speedup for 20 of 1,000 satellites. The scheduling layer has a similar structure: a smaller task set requires less constraint evaluation. Whether quality is preserved is empirical.

**Falsifiable:** H3 is falsified if SR_compute < 2× AND PWS(TARGETED) < 0.90 × PWS(FULL) simultaneously for IR < 0.10 — i.e., targeted rescheduling provides neither speed nor quality advantage even when only 10% of reservations are affected.

---

### H4 — Meta-Scheduler Policy Adaptation Under Capacity Shock

> Because orbital updates change the contact-window landscape (available capacity, load pressure, fragmentation), the Meta-Scheduler will select a different policy in at least some post-update scenarios. In those scenarios, applying the updated policy yields lower priority-weighted regret than reusing the pre-update policy without re-evaluation.

**Rationale:** `loadPressure`, `fragmentationPressure`, and `p10DeadlinePressure` are functions of the available window set. If a window disappears or shrinks, capacity decreases and `loadPressure` rises. The frozen policy boundary (`loadPressure ≥ 0.90 ∧ highPriorityFraction ≥ 0.20`) can be crossed by this shift.

**Boundary-adjacent workload controls:** A policy change can only be observed if the pre-update workload is near a decision boundary. Workloads far below the threshold will not cross it regardless of orbital perturbation. We define 5 target bands for workload generation:

| Region | `loadPressure` target | `highPriorityFraction` target |
|---|---|---|
| Below boundary | 0.65–0.75 | 0.05–0.15 |
| Near boundary (low) | 0.80–0.88 | 0.15–0.19 |
| At boundary | 0.89–0.92 | 0.19–0.21 |
| Near boundary (high) | 0.93–1.00 | 0.21–0.27 |
| Above boundary | 1.05–1.20 | 0.27–0.35 |

The realized workload features will be verified after generation to ensure they fall within the targets. Orbital updates that reduce capacity (increase `loadPressure`) will push near-boundary workloads across the threshold. This gives H4 a proper stress test.

**Falsifiable:** H4 is falsified if policy selection never changes across 100 controlled trials with boundary-adjacent workloads (near-boundary region, above) AND orbital updates producing IR > 0.10.

---

## 3. Experimental Structure: Two-Level Nested Design

### The fundamental experimental unit

The experiment has two distinct levels:

```
Level 1: Orbital Update Event
  └── Unique TLE pair (satellite s, T₀ epoch, T₁ epoch)
      └── Level 2: Workload Realization
              Controlled workload drawn from a fixed distribution,
              applied to the same window set derived from this TLE pair.
```

**Critical distinction:**

- **Level 1 (orbital events) are the unit of independence for H1 and H2.** Two workload realizations using the same TLE pair are *not* independent orbital observations. They share the same contact-window change structure.

- **Level 2 (workload realizations) are nested replicates within each orbital event.** They contribute statistical power for H3 and H4 but must not inflate the effective sample size for H1/H2.

### Stage C trial accounting

```
Target:   ≥ 100 distinct orbital update events
          per major orbital class (LEO circular, LEO SSO, GEO)

Per event: 5 boundary-region load levels
           × 10 independent workload realizations for each load region
           × 2 strategies (FULL, TARGETED)

Observations: 100 events × 5 load regions × 10 realizations × 2 strategies
            = 10,000 scheduling runs per class

Total (3 classes): 30,000 scheduling runs

Independent orbital observations: 100 per class × 3 classes = 300
```

**Statistical analysis:**
- H1 and H2: analysed at the TLE-pair level. Point estimates and CIs use cluster-robust bootstrap at the orbital-event level.
- H3 and H4: 30,000 clustered scheduling-run observations, analysed with mixed-effects models treating the orbital-update event as a random effect/cluster.
- **Do not report naïve bootstrap CIs computed over all 30,000 runs for H1/H2.** This would understate uncertainty about orbital behaviour.

---

## 4. TLE Corpus Construction (Stage A)

### 4.1 Primary source

CelesTrak historical GP (General Perturbations) data. CelesTrak explicitly maintains historical data for unclassified objects from 1957 through the latest update, accessible via its historical data request service.

**Operational constraint:** CelesTrak's historical archive limits requests to 10 per 24 hours and up to 100 satellites per request. The corpus must be built via archival requests submitted over multiple days — not a continuous high-frequency scrape. The collected data will be frozen locally before any experiment runs.

### 4.2 Pair selection and deduplication

A valid TLE update pair is the tuple `(satellite_id, T₀_epoch, T₁_epoch)` where:

1. `T₁.epoch > T₀.epoch`
2. `T₁.epoch − T₀.epoch ≥ 1 h` (minimum meaningful update gap)
3. The pair is from consecutive CelesTrak snapshots — no intermediate snapshot exists for the same satellite between T₀ and T₁

**Deduplication rule:** Each unique `(satellite_id, T₀_epoch, T₁_epoch)` tuple constitutes exactly one corpus entry. The same update event observed in two archive fetches is counted once.

### 4.3 Stratification

The corpus is stratified by orbital class because TLE update frequency and perturbation magnitude differ substantially:

| Class | Description | Update frequency |
|---|---|---|
| LEO circular | ~400–600 km, low eccentricity | Daily–several per day |
| LEO Sun-synchronous | ~600–900 km, inclination ~98° | Daily–several per day |
| GEO | ~35,786 km, near-zero inclination | Less frequent |
| MEO | ~2,000–20,000 km | Variable |

Target ≥ 100 unique update events per class (LEO circular, LEO SSO, GEO) before proceeding to Stage C. *MEO is retained as an optional exploratory stratum and is not part of the primary 300-event design.*

### 4.4 Manoeuvre flagging

TLE pairs where the new TLE indicates a likely manoeuvre — detectable as a large step in mean motion (`Δn > threshold`) or inclination change (`Δi > threshold`) — are flagged with `MANOEUVRE_SUSPECTED = TRUE`. These are retained in the corpus but analysed as a separate sub-population. A maneuvering satellite presents qualitatively different orbital-change dynamics and must not be pooled with passive re-fits.

### 4.5 Synthetic perturbations: permitted scope

Controlled synthetic TLE perturbations (e.g., adding a fixed Δe to eccentricity) are permitted **only** for:
- Validating the measurement pipeline (confirming WindowMatcher produces expected output for known inputs)
- Sensitivity analysis of the δ thresholds

They must **not** be used to report real-world effect sizes. Papers must explicitly state: *"In synthetic perturbation experiments..."* vs. *"Across real CelesTrak update pairs..."*

---

## 5. Stage B: Orbital-State and Window-Change Characterisation

For each corpus pair, compute:

### 5.1 Orbital-state metrics

Both TLEs are propagated over the same 24-hour horizon at 60-second intervals (1,440 points).

| Metric | Symbol | Definition |
|---|---|---|
| Mean position divergence | `μ_pos` | Mean Euclidean distance (km) between T₀ and T₁ propagated ECI positions across the horizon |
| Max position divergence | `max_pos` | Maximum position difference (km) across the horizon |
| Mean velocity divergence | `μ_vel` | Mean speed difference (m/s) across the horizon |
| TLE epoch gap | `Δt_epoch` | T₁.epoch − T₀.epoch in hours — recorded as metadata, **not treated as an explanatory variable** |

> **Terminology note:** `μ_pos`, `max_pos`, and `μ_vel` are **explanatory variables/covariates**, not independent variables. They are measured outcomes of the TLE pair — characteristics of the corpus observation, not experimental manipulations. The experimental manipulation is which orbital update event and workload are selected.

**Empirical divergence bins:** The distribution of `μ_pos` will be estimated first. Divergence bins will be defined based on observed quantiles (e.g., P0-P33, P33-P67, P67-P100) to ensure falsification tests for H1 evaluate the true, observed divergence distribution.

### 5.2 Window-change metrics

Computed via WindowMatcher (Section 6) on the generated window sets (W₀, W₁):

| Metric | Symbol | Definition |
|---|---|---|
| Changed window fraction | `CWF` | `(|disappeared| + |appeared| + |shifted_beyond_δ|) / |W₀|` |
| Disappearance rate | `WDR` | `|disappeared| / |W₀|` |
| Appearance rate | `WAR` | `|appeared| / |W₁|` |
| Mean AOS shift | `μ_Δaos` | Mean `|AOS(w₁) − AOS(w₀)|` over matched pairs (seconds) |
| Mean LOS shift | `μ_Δlos` | Mean `|LOS(w₁) − LOS(w₀)|` over matched pairs (seconds) |
| Mean relative duration delta | `μ_Δdur` | Mean `|duration(w₁) − duration(w₀)| / duration(w₀)` |

**Primary Stage B finding:** Fit `CWF ~ f(μ_pos)` across the corpus. The shape of this relationship — linear, sublinear, threshold-like — is the main characterisation result and informs H1.

---

## 6. WindowMatcher: Specification

Contact windows do not carry persistent identities across TLE updates — new database IDs are assigned on every regeneration. Window matching is a prerequisite for comparing W₀ and W₁.

### 6.1 Matching contract

For each (satellite, ground station) pair, construct candidate matches satisfying the overlap threshold and select a **maximum-overlap one-to-one matching**.
- A set of **matched pairs** `{(w₀, w₁)}` where each w₀ is paired with at most one w₁ and vice versa.
- A set of **disappeared windows** (w₀ with no match in W₁)
- A set of **appeared windows** (w₁ with no match in W₀)

### 6.2 Candidate match condition

`w₀` and `w₁` are candidates if:

```
w₀.satelliteId = w₁.satelliteId
AND w₀.groundStationId = w₁.groundStationId
AND overlap(w₀, w₁) / min(duration(w₀), duration(w₁)) ≥ θ_overlap
```

Default: `θ_overlap = 0.50`.

### 6.3 Algorithm Independence

**The implementation algorithm is explicitly independent of the specification.** Because contact windows for a given (satellite, station) pair are sorted by AOS and typically sparse, a greedy maximum-overlap scan is sufficient and runs in O(n log n). The research question does not require proving that a general O(n³) bipartite matching (e.g., Hungarian algorithm) is optimal, and such overhead should not be introduced into the timing-critical path of Stage C impact analysis. The matcher must simply fulfill the contract above.

### 6.4 Special case classification

| Case | Classification |
|---|---|
| One-to-one match | matched_pair |
| w₀ with no candidate | disappeared (always CHANGED) |
| w₁ with no candidate | appeared (always CHANGED) |
| w₀ matched to best-overlap w₁; second w₁ candidate unmatched | second w₁ = appeared (split case, flagged) |
| Two w₀ candidates; one matched to w₁; other unmatched | unmatched w₀ = disappeared (merge case, flagged) |

Split and merged windows are flagged in the corpus for sensitivity analysis.

### 6.5 Window change classification

After matching:

```
UNCHANGED if matched AND:
  |AOS(w₁) − AOS(w₀)| ≤ δ_aos
  AND |LOS(w₁) − LOS(w₀)| ≤ δ_los
  AND |duration(w₁) − duration(w₀)| / duration(w₀) ≤ δ_dur_rel

CHANGED otherwise (disappeared, appeared, or shifted beyond threshold)
```

Default thresholds: `δ_aos = δ_los = 30 s`, `δ_dur_rel = 0.05`. Swept in sensitivity analysis.

---

## 7. Reservation Validity and Impact (Corrected)

### 7.1 Satellite Reservation Exposure

Before running WindowMatcher, compute SRE:

```
SRE = |{ r ∈ S₀ : r.satelliteId ∈ U }| / |S₀|
```

SRE provides the structural upper bound on IR: `IR ≤ SRE`.

### 7.2 Valid Reservation Under T₁

A reservation `r ∈ S₀` is **valid under T₁** if at least one window in the new window set fully contains the allocated interval for the same satellite and station:

```
VALID(r, T₁) iff

∃ w₁ ∈ W₁:
  w₁.satelliteId    = r.satelliteId
  AND w₁.groundStationId = r.groundStationId
  AND AOS(w₁) ≤ r.allocatedStart
  AND r.allocatedEnd ≤ LOS(w₁)
```

### 7.3 Derived Sets

```
R_invalidated = { r ∈ S₀ : NOT VALID(r, T₁) }
T_affected    = { t : reservation(t) ∈ R_invalidated }
```

Tasks with no reservation (PENDING, UNSCHEDULED) are not affected — they have nothing to invalidate.

### 7.4 Slideable Reservation

```
SLIDEABLE(r, T₁) iff NOT VALID(r, T₁)
AND ∃ w₁ ∈ W₁:
  w₁.satelliteId    = r.satelliteId
  AND w₁.groundStationId = r.groundStationId
  AND (LOS(w₁) − AOS(w₁)) ≥ r.duration
  AND slide_slot_available(r, w₁, S₀)
```

Slideable reservations are handled in TARGETED-SLIDE (Strategy 3). They are distinguished from hard invalidations in all reported metrics.

---

## 8. Rescheduling Strategies

**CRITICAL INVARIANT:** For every trial, FULL and TARGETED operate on the **identical frozen W₁** generated from the same T₁ propagation parameters. The experiment generates W₁ once and uses it for both strategies to prevent numerical contamination.

### Strategy 1 — Full Regeneration (FULL)

```
1. Cancel ALL existing reservations.
2. Ensure W₁ is generated for all satellites.
3. Set all tasks to PENDING.
4. Run Meta-Scheduler on the full task set using W₁.
```

This is the naive baseline — it discards all scheduling work regardless of whether tasks were affected.

---

### Strategy 2 — Targeted Incremental Rescheduling (TARGETED)

```
1. Ensure W₁ is incrementally generated for U satellites.
2. Run WindowMatcher on (W₀[U], W₁[U]).
3. Run ReservationImpactAnalyzer → R_invalidated, T_affected.
4. Cancel only R_invalidated.
5. Set only T_affected to PENDING.
6. Run Meta-Scheduler on T_affected only.
   Unaffected tasks retain their existing valid reservations.
```

---

### Strategy 3 (Extension) — Slide-First Targeted (TARGETED-SLIDE)

Before cancelling an invalidated reservation, attempt to slide it:

```
For each r ∈ R_invalidated:
  if SLIDEABLE(r, T₁) AND slide_slot_available(r, T₁):
    adjust r.allocatedStart, r.allocatedEnd  (duration unchanged)
    mark r as SLID
  else:
    cancel r, add t to T_affected

Run Meta-Scheduler on remaining T_affected.
```

This is a second-order experiment, run only after FULL vs. TARGETED results are established.

---

## 9. Timing Definitions and Speedup Metrics

### 9.1 The confounding problem

FULL and TARGETED are not symmetric in their bookkeeping: TARGETED requires impact analysis (WindowMatcher + ReservationImpactAnalyzer) that FULL does not. Depending on what is included in the timing boundary, targeted recovery can appear artificially faster or artificially slower.

**Two timing metrics are therefore required, reported separately for every experimental cell.**

### 9.2 SR_compute — Computational Speedup

Measures only the core computation that each strategy performs:

```
SR_compute = (t_regen_all + t_sched_full) /
             (t_regen_partial + t_sched_targeted)
```

Where:
- `t_regen_all`: window regeneration for ALL satellites (FULL)
- `t_regen_partial`: window regeneration for U satellites only (TARGETED)
- `t_sched_full`: Meta-Scheduler run over all tasks
- `t_sched_targeted`: Meta-Scheduler run over T_affected only

**Not included in SR_compute:** `t_match` (WindowMatcher), `t_impact` (ReservationImpactAnalyzer). These are charged to neither strategy in the computational comparison because they are analysis costs, not scheduling costs.

### 9.3 SR_e2e — End-to-End Operational Speedup

Measures everything from the moment of update detection to the moment a valid schedule exists:

```
SR_e2e = t_total_FULL / t_total_TARGETED

t_total_FULL     = t_regen_all + t_sched_full
t_total_TARGETED = t_regen_partial + t_match + t_impact + t_sched_targeted
```

SR_e2e is the operationally relevant metric: it is the wall-clock time an operations team would wait before they can act on a recovered schedule.

**SR_e2e is harder to game than SR_compute.** TARGETED is charged for its analysis overhead. If SR_e2e remains substantially greater than 1× even with that overhead, targeted recovery is operationally justified.

### 9.4 Reporting

For each (orbital divergence bucket, sat_count, N, load_level) cell, report:
- SR_compute: median, P25, P75, P95, 95% cluster-bootstrap CI
- SR_e2e: same
- `t_match` and `t_impact` separately (so readers can audit the decomposition)

---

## 10. Measurable Metrics (Complete)

### 10.1 Orbital-State Metrics (Stage A/B)
→ See Section 5.1

### 10.2 Window-Change Metrics (Stage B)
→ See Section 5.2

### 10.3 Satellite Reservation Exposure

| Metric | Symbol | Definition |
|---|---|---|
| Satellite reservation exposure | `SRE` | `|{r ∈ S₀ : r.satelliteId ∈ U}| / |S₀|` |

### 10.4 Schedule-Impact Metrics (Stage C)

| Metric | Symbol | Definition |
|---|---|---|
| Invalidation rate | `IR` | `|R_invalidated| / |S₀|` |
| Schedule preservation rate | `SPR` | `1 − IR` = fraction of baseline schedule that survives unchanged |
| Affected task fraction | `ATF` | `|T_affected| / |all tasks|` |
| Schedule churn | `SC` | Fraction of reservations changed between S₀ and S₁ |
| Slideable fraction | `SlF` | `|R_slideable| / |R_invalidated|` |

> **Note on SPR vs. IR:** Both `SPR` and `IR` are reported. They convey identical structural information (`SPR = 1 - IR`), but communicate differently to distinct audiences. "8% invalidated" highlights the breakage, while "92% schedule preservation" provides intuitive operational context about how much of the baseline schedule remains sound.

### 10.5 Computation Metrics

| Metric | Symbol | Definition |
|---|---|---|
| Incremental window regen time | `t_regen_partial` | ms, U satellites only |
| Full window regen time | `t_regen_all` | ms, all satellites |
| WindowMatcher time | `t_match` | ms |
| Impact analysis time | `t_impact` | ms |
| Full scheduler time | `t_sched_full` | ms |
| Targeted scheduler time | `t_sched_targeted` | ms |
| Computational speedup | `SR_compute` | `(t_regen_all + t_sched_full) / (t_regen_partial + t_sched_targeted)` |
| End-to-end speedup | `SR_e2e` | `(t_regen_all + t_sched_full) / (t_regen_partial + t_match + t_impact + t_sched_targeted)` |

### 10.6 Schedule-Quality Metrics (same definitions as Phase 5)

| Metric | Symbol | Definition |
|---|---|---|
| Throughput | `TP` | `scheduled / total_tasks` |
| Deadline miss rate | `DMR` | `tasks_missing_deadline / total_tasks` |
| Priority-weighted success | `PWS` | `Σ(priority_i × scheduled_i) / Σ(priority_i)` |
| Oracle regret (throughput) | `R_tp` | `(TP_oracle − TP_strategy) / TP_oracle` |
| Oracle regret (PWS) | `R_pws` | `(PWS_oracle − PWS_strategy) / PWS_oracle` |

**CRITICAL INVARIANT:** The Oracle, FULL, and TARGETED strategies MUST evaluate the **identical workload realization** (same task IDs, priorities, durations, deadlines, random seed, station set, and horizon) for every trial. `L_oracle = L_baseline = L_FULL = L_TARGETED`. Only the scheduling information available to the strategy differs.

### 10.7 Meta-Scheduler Policy Metrics

| Metric | Definition |
|---|---|
| Policy change rate | Fraction of trials where post-update policy ≠ baseline policy |
| Δ_load | `loadPressure(T₁) − loadPressure(T₀)` |
| Δ_fragmentation | `fragmentationPressure(T₁) − fragmentationPressure(T₀)` |
| Policy-blind regret | PWS regret when T₀'s policy is reused without re-evaluation after the update |

---

## 11. Experimental Controls and Variables

### 11.1 Fixed Controls

| Control | Value | Rationale |
|---|---|---|
| Ground station set | 4 KSAT stations | Defined in seed |
| Window horizon | 24 h | Same as production |
| SGP4 step size | 10 s | Same as production |
| Task duration distribution | Uniform [120 s, 600 s] | Covers typical LEO pass durations |
| Priority distribution | Uniform [1, 10] | Same as Phase 5 |
| Deadline distribution | [T₀+2h, T₀+24h] | Ensures non-trivial deadline pressure |
| Meta-Scheduler version | 5.4.0 | Frozen — must not change |
| Policy selection thresholds | p10 ≤ 60; load ≥ 0.90 ∧ hpf ≥ 0.20 | Frozen from Phase 4 campaign |
| Window matching threshold | θ_overlap = 0.50 | Default; swept in sensitivity analysis |

### 11.2 Experimental Factors

| Factor | Values | Level | Tests |
|---|---|---|---|
| Number of updated satellites | {1, 5, 10, 20} | Orbital event | H1, H2, H3 |
| Orbital divergence bucket | {low, medium, high} (Empirical Stage B) | Orbital event | H1, H2 |
| Task count N | {20, 50, 100} | Workload realization | H3 |
| Load region | {below, near-low, at, near-high, above} (Section 2, H4) | Workload realization | H4 |
| AOS/LOS threshold δ | {10, 30, 60, 120} s | Sensitivity sweep | H1 |

> **Reminder:** Orbital divergence bucket is an **explanatory covariate** derived from µ_pos observed in Stage B, not an experimentally manipulated quantity.

### 11.3 Sample Size

```
Corpus target:  ≥ 100 unique orbital update events per class
                × 3 classes (LEO circular, LEO SSO, GEO) = 300 events

Stage C:        300 events
                × 5 boundary-region load levels
                × 10 independent workload realizations
                × 2 strategies (FULL, TARGETED)
                = 30,000 scheduling runs

Independent orbital observations (H1, H2 analysis): 300
Clustered scheduling-run observations (H3, H4 analysis): 30,000
```

Statistical models for H1/H2 use the 300 orbital events as the unit. H3/H4 models treat the orbital event as a random effect/cluster, with scheduling runs as the within-cluster observations.

---

## 12. Separation from Frozen Phase 5 Benchmark

Phase 5 answers: *"Which scheduling policy maximises throughput/PWS across a fixed synthetic workload distribution?"*

This experiment answers: *"How does a post-hoc orbital change degrade an existing schedule, and can targeted recovery restore quality efficiently?"*

### Concrete isolation guarantees

1. **Separate lab database.** Mirrors `lab-db-guard.ts`. No shared state with production or Phase 5 runs.
2. **No modification to frozen files.** `meta-scheduler.ts`, `policy-selector.ts`, `workload-analyzer.ts`, and `research/orbitmesh-phase5-final-validation.zip` are immutable.
3. **Separate runner.** `scheduler-lab/scheduling-impact-runner.ts` does not export any symbol used by production code.
4. **Separate results directory.** `research/scheduling-impact/` — separate from Phase 5 output.
5. **No cross-contamination of regret claims.** Phase 5 regret (0.07% miss-rate, 0.36% weighted-success) is from a static workload distribution. This experiment's regret is from post-update recovery. They are not numerically comparable without explicit framing.

---

## 13. Publishability Assessment

### What remains merely engineering

- *"Targeted rescheduling is faster than full rescheduling."* Expected. A Pareto frontier is needed, not a single number.
- *"Our system detects orbital changes."* System-building result.

### What clears the publishability threshold

**A. A quantitative characterisation of CWF as a function of orbital-state divergence (H1, Stage B)**

*"For TLE pairs producing mean position divergence in the P33-P67 quantile, the median CWF is Z% (95% CI: [Z_lo, Z_hi])."* Publishable if the relationship is nonlinear, class-stratified, or otherwise non-obvious.

**B. SRE as an Operational Predictor of Invalidation (H2, Stage C)**

*"SRE is highly predictive of IR (β1 = ..., p < .001). The invalidation-to-exposure ratio ρ remained tightly bound in [a, b], demonstrating that scheduled workload concentration on updated satellites dominates the disruption magnitude."* Publishable because it validates SRE as an operational pre-screening tool.

**C. SR_e2e Pareto frontier (H3)**

*"TARGETED achieves ≥ X% of FULL's PWS at SR_e2e ≥ Y× whenever IR < Z%."* Publishable if the frontier is well-defined and the quality-cost tradeoff is characterised across load levels.

**D. Policy re-evaluation reduces regret post-update (H4)**

*"Applying the baseline policy post-update yields X% higher PWS regret than re-running policy selection, in boundary-adjacent workloads (load ≈ 0.90)."* Directly extends Phase 5 from static to dynamic policy adaptation.

### Suggested paper framing

> **"Adaptive Mission Scheduling Under Orbital Ephemeris Updates in Satellite Ground-Station Networks"**
>
> We characterise the propagation of real CelesTrak TLE updates into contact-window perturbations (H1), quantify reservation invalidation rates as a function of satellite reservation exposure (H2), and show that targeted rescheduling achieves a favorable quality–cost frontier relative to full schedule regeneration (H3). We further demonstrate that workload-aware policy selection — effective for static workloads in prior work — reduces priority-weighted regret in post-update conditions (H4).

---

## 14. Explicitly Out of Scope

| Excluded | Reason |
|---|---|
| WebSockets / live satellite tracking | Engineering feature, not research |
| Re-optimising policy selection thresholds | Phase 5 is frozen |
| New scheduling policies | Would require a new Phase 5-scale campaign |
| Autonomous rescheduling triggers in production | Infrastructure, not research |
| Treating TLE epoch gap as orbital perturbation magnitude | Methodologically incorrect |
| Reporting synthetic perturbation results as real-world evidence | Must be labelled separately |
| Naïve bootstrap CIs over all scheduling runs for H1/H2 | Would understate uncertainty at the orbital-event level |

---

## 15. Implementation Dependencies (Not Yet Started)

When this design is approved, built in order with separate reviews:

1. **TLE corpus collector** — archives CelesTrak snapshots within API limits to build Stage A dataset
2. **`WindowMatcher`** — implements Section 6 contract; standalone; validated against synthetic test cases before use in Stage C
3. **`ReservationImpactAnalyzer`** — implements Section 7; standalone
4. **`SchedulingImpactRunner`** — orchestrates Stages C–D; writes to `research/scheduling-impact/`
5. **`TargetedRescheduler`** — wraps Meta-Scheduler to accept a constrained task set

None of these will be started until this document is reviewed and approved.

---

*This is a design document only. No production code, schema, Meta-Scheduler files, Phase 5 files, or research benchmark artifacts have been modified.*
