import assert from 'assert';
import { selectPolicy } from '../modules/meta-scheduler/policy-selector';
import { WorkloadFeatures } from '../modules/meta-scheduler/types';

function makeFeatures(overrides: Partial<WorkloadFeatures> = {}): WorkloadFeatures {
  return {
    taskCount: 100,
    totalTaskDemandSeconds: 1000,
    usableCapacitySeconds: 5000,
    loadPressure: 0.2, // Default: Low Load
    medianDeadlinePressure: 100,
    p10DeadlinePressure: 100, // Default: Loose Deadline
    tightTaskFraction: 0,
    highPriorityFraction: 0, // Default: Low Priority
    meanGapSeconds: 500,
    p10GapSeconds: 100,
    largestGapSeconds: 1000,
    fragmentationPressure: 0, // Default: No fragmentation
    ...overrides
  };
}

async function runTests() {
  console.log("=== PHASE 5.2: POLICY SELECTOR TESTS ===");

  // Test 1: Low load -> FCFS
  let decision = selectPolicy(makeFeatures());
  assert.strictEqual(decision.policy, 'FCFS');
  console.log("✅ Test 1: Low load -> FCFS");

  // Test 2: High priority + high load -> PRIORITY
  decision = selectPolicy(makeFeatures({
    loadPressure: 0.95,
    highPriorityFraction: 0.30
  }));
  assert.strictEqual(decision.policy, 'PRIORITY');
  console.log("✅ Test 2: High priority + high load -> PRIORITY");

  // Test 3: Fragmented workload -> FCFS (since we dropped the fragmentation rule)
  decision = selectPolicy(makeFeatures({
    loadPressure: 0.50,
    fragmentationPressure: 0.75
  }));
  assert.strictEqual(decision.policy, 'FCFS');
  assert.strictEqual(decision.reason, 'BALANCED_WORKLOAD');
  console.log("✅ Test 3: Fragmented workload defaults to FCFS");

  // Test 4: Tight deadlines -> PRIORITY
  decision = selectPolicy(makeFeatures({
    p10DeadlinePressure: 50
  }));
  assert.strictEqual(decision.policy, 'PRIORITY');
  assert.strictEqual(decision.reason, 'EXTREME_DEADLINE_PRESSURE');
  console.log("✅ Test 4: Tight deadlines -> PRIORITY");

  // Test 5: Exact boundary for Deadline Pressure
  assert.strictEqual(selectPolicy(makeFeatures({ p10DeadlinePressure: 59.99 })).policy, 'PRIORITY');
  assert.strictEqual(selectPolicy(makeFeatures({ p10DeadlinePressure: 60.00 })).policy, 'PRIORITY');
  assert.strictEqual(selectPolicy(makeFeatures({ p10DeadlinePressure: 60.01 })).policy, 'FCFS');
  console.log("✅ Test 5: Exact boundary deterministic tests passed");

  // Test 6: Determinism
  const f = makeFeatures({ loadPressure: 0.95, highPriorityFraction: 0.30 });
  const d1 = selectPolicy(f);
  const d2 = selectPolicy(f);
  assert.deepStrictEqual(d1, d2);
  console.log("✅ Test 6: Determinism passed");
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
