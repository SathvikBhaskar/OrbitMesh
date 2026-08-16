import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { db } from "../db/client";
import { schedulerRuns } from "../db/schema";
import { resetLabDatabase, runPolicyExperiment } from "../modules/scheduler-lab/policy-runner";
import { MetaScheduler } from "../modules/meta-scheduler/meta-scheduler";
import { WorkloadGenerator } from "../modules/scheduler-lab/workload-generator";
import { sql } from "drizzle-orm";

describe("Phase 5.4 - Meta-Scheduler Observability & Fail-Safes", () => {
  before(async () => {
    await resetLabDatabase();
  });

  after(async () => {
    await resetLabDatabase();
  });

  it("should successfully log a scheduler_run entry after a successful schedule", async () => {
    // Generate a simple workload
    const workload = new WorkloadGenerator({
      seed: "OBSERVABILITY_TEST_1",
      referenceTime: new Date("2026-08-16T12:00:00Z"),
      taskCount: 20,
      satelliteCount: 1,
      stationCount: 1,
      deadlineRegime: "LOOSE",
      priorityDistribution: "BALANCED",
      durationDistribution: "SHORT",
      arrivalSpreadSeconds: 3600
    }).generate();

    console.log("GENERATED TASKS:", workload.tasks.length);

    // Run the META policy
    await runPolicyExperiment("META", workload);

    // Check the database for the run
    const runs = await db.select().from(schedulerRuns);
    assert.strictEqual(runs.length, 1, "Expected exactly one scheduler_run to be logged.");
    
    const run = runs[0]!;
    assert.strictEqual(run.runType, "LAB", "Run type should be LAB");
    assert.ok(run.executionStatus === "SUCCESS" || run.executionStatus === "PARTIAL", "Execution status should be SUCCESS or PARTIAL");
    assert.ok(run.selectedPolicy === "FCFS" || run.selectedPolicy === "PRIORITY", "Selected policy should be valid");
    assert.ok(run.taskCount === 20, "Task count should match workload");
    assert.ok(run.loadPressure! > 0, "Features should be populated");
  });

  it("should enforce fail-fast boundary when feature extraction fails", async () => {
    MetaScheduler._mockExtractionFailure = true;

    const scheduler = new MetaScheduler(undefined, "LAB");
    let threw = false;

    try {
      await scheduler.schedulePendingTasks();
    } catch (e: any) {
      threw = true;
      assert.match(e.message, /Feature extraction failed: MOCKED_EXTRACTION_FAILURE/);
    } finally {
      MetaScheduler._mockExtractionFailure = false;
    }

    assert.ok(threw, "Scheduler should have thrown an error on feature extraction failure");

    // Verify it logged the failure
    const runs = await db.select().from(schedulerRuns).where(sql`execution_status = 'FAILED_FEATURE_EXTRACTION'`);
    assert.strictEqual(runs.length, 1, "Expected exactly one FAILED_FEATURE_EXTRACTION log");
    
    const run = runs[0]!;
    assert.strictEqual(run.errorMessage, "MOCKED_EXTRACTION_FAILURE");
  });
});
