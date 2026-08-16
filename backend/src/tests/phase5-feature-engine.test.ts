import assert from "assert";
import { calculateFeatures } from '../modules/meta-scheduler/workload-analyzer';
import { Task, ContactWindow, Reservation } from '../modules/meta-scheduler/types';

async function runFeatureEngineTests() {
  console.log("=== PHASE 5.1: FEATURE ENGINE TESTS ===");

  const refTime = new Date('2025-01-01T10:00:00Z');

  function makeTask(id: string, durationSec: number, priority: number, deadlineSecOffset: number): Task {
    return {
      id,
      priority,
      duration_ms: durationSec * 1000,
      deadline: new Date(refTime.getTime() + deadlineSecOffset * 1000).toISOString(),
      created_at: new Date().toISOString(),
      name: `t_${id}`,
      satellite_id: 'sat1',
      status: 'PENDING'
    };
  }

  function makeWindow(id: string, station: string, startOffset: number, endOffset: number): ContactWindow {
    return {
      id,
      ground_station_id: station,
      aos: new Date(refTime.getTime() + startOffset * 1000).toISOString(),
      los: new Date(refTime.getTime() + endOffset * 1000).toISOString(),
      satellite_id: 'sat1',
      duration_seconds: endOffset - startOffset,
      max_elevation_deg: 45
    } as any;
  }

  function makeRes(id: string, station: string, startOffset: number, endOffset: number): Reservation {
    return {
      id,
      mission_task_id: `t_${id}`,
      ground_station_id: station,
      satellite_id: 'sat1',
      allocated_start: new Date(refTime.getTime() + startOffset * 1000).toISOString(),
      allocated_end: new Date(refTime.getTime() + endOffset * 1000).toISOString(),
      created_at: new Date().toISOString(),
    } as any;
  }

  // --- TEST 1 ---
  console.log("Test 1: Basic workload");
  let tasks = [
    makeTask('t1', 100, 5, 200), // D = 2
    makeTask('t2', 100, 5, 200), // D = 2
  ];
  let windows = [
    makeWindow('w1', 's1', 0, 500),
    makeWindow('w2', 's2', 0, 500),
  ];
  let features = calculateFeatures(tasks, windows, [], refTime);

  assert.strictEqual(features.taskCount, 2);
  assert.strictEqual(features.totalTaskDemandSeconds, 200);
  assert.strictEqual(features.usableCapacitySeconds, 1000);
  assert.strictEqual(features.loadPressure, 200 / 1000);
  assert.strictEqual(features.medianDeadlinePressure, 2);
  assert.strictEqual(features.highPriorityFraction, 0);
  assert.strictEqual(features.meanGapSeconds, 500);

  // --- TEST 2 ---
  console.log("Test 2: Overlapping windows");
  windows = [
    makeWindow('w1', 's1', 0, 600), // 10:00 - 10:10
    makeWindow('w2', 's1', 300, 900), // 10:05 - 10:15
  ];
  features = calculateFeatures([makeTask('t', 10, 5, 100)], windows, [], refTime);
  assert.strictEqual(features.usableCapacitySeconds, 900); // not 1200

  // --- TEST 3 ---
  console.log("Test 3: Existing reservations");
  windows = [
    makeWindow('w1', 's1', 0, 1200), // 10:00 - 10:20
  ];
  let reservations = [
    makeRes('r1', 's1', 300, 600), // 10:05 - 10:10 (300s)
  ];
  features = calculateFeatures([makeTask('t', 10, 5, 100)], windows, reservations, refTime);
  assert.strictEqual(features.usableCapacitySeconds, 900);
  assert.strictEqual(features.meanGapSeconds, 450);
  assert.strictEqual(features.largestGapSeconds, 600);

  // --- TEST 4 ---
  console.log("Test 4: Deadline pressure");
  tasks = [
    makeTask('t1', 100, 5, 100),   // D = 1
    makeTask('t2', 100, 5, 200),   // D = 2
    makeTask('t3', 100, 5, 400),   // D = 4
    makeTask('t4', 100, 5, 1000),  // D = 10
  ];
  features = calculateFeatures(tasks, [makeWindow('w', 's1', 0, 1000)], [], refTime);
  assert.strictEqual(features.p10DeadlinePressure, 1.3);
  assert.strictEqual(features.medianDeadlinePressure, 3);
  assert.strictEqual(features.tightTaskFraction, 0.25);

  // --- TEST 5 ---
  console.log("Test 5: Priority pressure");
  tasks = Array.from({ length: 10 }, (_, i) => makeTask(`t${i}`, 100, i < 4 ? 8 : 5, 1000));
  features = calculateFeatures(tasks, [makeWindow('w', 's1', 0, 1000)], [], refTime);
  assert.strictEqual(features.highPriorityFraction, 0.4);

  // --- TEST 6 ---
  console.log("Test 6: Fragmentation");
  windows = [
    makeWindow('w1', 's1', 0, 100),
    makeWindow('w2', 's2', 0, 200),
    makeWindow('w3', 's3', 0, 300),
    makeWindow('w4', 's4', 0, 600),
    makeWindow('w5', 's5', 0, 1000),
  ];
  features = calculateFeatures([makeTask('t1', 400, 5, 1000)], windows, [], refTime);
  assert.strictEqual(features.fragmentationPressure, 3/5);

  // --- TEST 7 ---
  console.log("Test 7: Zero capacity");
  features = calculateFeatures([makeTask('t1', 100, 5, 1000)], [], [], refTime);
  assert.strictEqual(features.usableCapacitySeconds, 0);
  assert.strictEqual(features.loadPressure, 1.0);
  assert.strictEqual(features.fragmentationPressure, 0);

  // --- TEST 8 ---
  console.log("Test 8: Empty task set");
  features = calculateFeatures([], [makeWindow('w', 's', 0, 100)], [], refTime);
  assert.strictEqual(features.taskCount, 0);
  assert.strictEqual(features.totalTaskDemandSeconds, 0);
  assert.strictEqual(features.highPriorityFraction, 0);
  assert.strictEqual(features.tightTaskFraction, 0);

  // --- TEST 9 ---
  console.log("Test 9: Determinism");
  tasks = [makeTask('t1', 100, 8, 200), makeTask('t2', 150, 5, 500)];
  windows = [makeWindow('w1', 's1', 0, 600), makeWindow('w2', 's1', 500, 1000)];
  const feat1 = calculateFeatures(tasks, windows, [], refTime);
  const feat2 = calculateFeatures(tasks, windows, [], refTime);
  assert.deepStrictEqual(feat1, feat2);

  // --- TEST 10 ---
  console.log("Test 10: Reference-time sensitivity");
  tasks = [makeTask('t1', 100, 5, 300)]; 
  const featT1 = calculateFeatures(tasks, [makeWindow('w', 's', 0, 1000)], [], refTime);
  assert.strictEqual(featT1.medianDeadlinePressure, 3);

  const t2 = new Date(refTime.getTime() + 100 * 1000);
  const featT2 = calculateFeatures(tasks, [makeWindow('w', 's', 0, 1000)], [], t2);
  assert.strictEqual(featT2.medianDeadlinePressure, 2);

  console.log("✅ All tests passed successfully!");
}

runFeatureEngineTests().catch(err => {
  console.error("Test failed", err);
  process.exit(1);
});
