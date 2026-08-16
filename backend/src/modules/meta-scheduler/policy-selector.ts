import { WorkloadFeatures, PolicyReason } from './types';

export type ProductionPolicy = 'FCFS' | 'PRIORITY' | 'HYBRID_SLACK';

export interface PolicyDecision {
  policy: ProductionPolicy;
  reason: PolicyReason;
  features: WorkloadFeatures;
}

/**
 * Deterministic policy selection derived from the Phase 4 campaign analysis.
 * 
 * Rule Definitions & Ordering:
 * 1. Deadline Safety (p10DeadlinePressure <= 60): 
 *    Checked first. Workloads with p10DeadlinePressure <= 60 represent the bottom ~32% 
 *    of the deadline spread. In this region, FCFS experiences extreme queuing delays (P95 ~12.5M ms). 
 *    PRIORITY explicitly drops low-value work, minimizing deadline misses and latency.
 *    (Matches 174/540 workloads. Priority wins plurality: 75 vs 63 FCFS).
 * 
 * 2. Workload Objective (loadPressure >= 0.90 && highPriorityFraction >= 0.20): 
 *    Checked second. If deadlines are safe but capacity is heavily constrained with a critical mass 
 *    of high-priority work, we maximize priority-weighted success by explicitly favoring PRIORITY. 
 *    (Matches 156/540 workloads. Priority dominates: 126 vs 20 FCFS).
 * 
 * NOTE on Fragmentation: 
 *    Initial hypothesis was that high fragmentation favored HYBRID_SLACK. However, campaign data 
 *    shows that for `load >= 0.30 && fragmentation >= 0.60`, FCFS still won 45 times vs Slack's 17 times.
 *    Because the campaign data did not support the hypothesis, the rule was omitted.
 * 
 * NOTE on Rule Overlap:
 *    Approximately 127/540 workloads satisfy multiple conditions. Because both rules currently map 
 *    to PRIORITY, ordering does not practically conflict, but deadline safety is logically prioritized 
 *    first over general throughput maximization.
 */
export function selectPolicy(features: WorkloadFeatures): PolicyDecision {
  // Constraint 1: Deadline Safety
  if (features.p10DeadlinePressure <= 60) {
    return {
      policy: 'PRIORITY',
      reason: 'EXTREME_DEADLINE_PRESSURE',
      features
    };
  }

  // Constraint 2: Workload Objective
  if (features.loadPressure >= 0.90 && features.highPriorityFraction >= 0.20) {
    return {
      policy: 'PRIORITY',
      reason: 'HIGH_LOAD_PRIORITY_PRESSURE',
      features
    };
  }

  // Default / Balanced
  return {
    policy: 'FCFS',
    reason: 'BALANCED_WORKLOAD',
    features
  };
}
