import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { db } from "../db/client";
import { schedulerRuns, reservations, contactWindows, missionTasks, satelliteOrbitalData, groundStations, satellites } from "../db/schema";
import { MetaScheduler } from "../modules/meta-scheduler/meta-scheduler";
import { CandidateService } from "../modules/scheduler/candidate-service";
import { FcfsScheduler } from "../modules/scheduler/fcfs-scheduler";
import { sql, eq } from "drizzle-orm";
import { GeneratedWorkload } from "../modules/scheduler-lab/workload-generator";
import { resetLabDatabase, seedLabDatabase, runPolicyExperiment } from "../modules/scheduler-lab/policy-runner";

describe("Phase 5.5 - Failure Semantics", () => {
  before(async () => {
    await resetLabDatabase();
  });

  after(async () => {
    MetaScheduler._mockExtractionFailure = false;
    await resetLabDatabase();
  });

  it("Failure A - Feature extraction fails: 0 reservations, FAILED_FEATURE_EXTRACTION logged", async () => {
    await resetLabDatabase();

    const workload: GeneratedWorkload = {
      satellites: [{ id: "11111111-1111-1111-1111-111111111111", noradId: 99991, name: "Sat1" }],
      stations: [{ id: "22222222-2222-2222-2222-222222222222", name: "Stn1" }],
      windows: [{ id: "33333333-3333-3333-3333-333333333331", satelliteId: "11111111-1111-1111-1111-111111111111", groundStationId: "22222222-2222-2222-2222-222222222222", aos: new Date("2026-08-16T10:00:00Z"), los: new Date("2026-08-16T10:10:00Z"), durationSeconds: 600, maxElevationDeg: 90 }] as any,
      tasks: [{ id: "44444444-4444-4444-4444-444444444441", satelliteId: "11111111-1111-1111-1111-111111111111", priority: 1, durationSeconds: 60, windowId: "33333333-3333-3333-3333-333333333331", deadline: new Date("2026-08-16T11:00:00Z"), createdAt: new Date("2026-08-16T09:00:00Z"), status: "PENDING" }]
    };

    await seedLabDatabase(workload);

    MetaScheduler._mockExtractionFailure = true;

    try {
      await runPolicyExperiment("META", workload);
      assert.fail("Should have thrown an extraction error");
    } catch (err: any) {
      assert.match(err.message, /Feature extraction failed/);
    }
    
    MetaScheduler._mockExtractionFailure = false;

    // Verify 0 reservations
    const resCount = await db.select({ count: sql`count(*)` }).from(reservations);
    assert.strictEqual(Number(resCount[0]!.count), 0, "No reservations should be created");

    // Verify FAILED_FEATURE_EXTRACTION logged
    const runs = await db.select().from(schedulerRuns);
    assert.strictEqual(runs.length, 1, "One run logged");
    assert.strictEqual(runs[0]!.executionStatus, "FAILED_FEATURE_EXTRACTION");
  });

  it("Failure B - Observability failure: reservations remain committed", async () => {
    await resetLabDatabase();

    const workload: GeneratedWorkload = {
      satellites: [{ id: "11111111-1111-1111-1111-111111111112", noradId: 99992, name: "Sat2" }],
      stations: [{ id: "22222222-2222-2222-2222-222222222223", name: "Stn2" }],
      windows: [{ id: "33333333-3333-3333-3333-333333333332", satelliteId: "11111111-1111-1111-1111-111111111112", groundStationId: "22222222-2222-2222-2222-222222222223", aos: new Date("2026-08-16T10:00:00Z"), los: new Date("2026-08-16T10:10:00Z"), durationSeconds: 600, maxElevationDeg: 90 }] as any,
      tasks: [{ id: "44444444-4444-4444-4444-444444444442", satelliteId: "11111111-1111-1111-1111-111111111112", priority: 1, durationSeconds: 60, windowId: "33333333-3333-3333-3333-333333333332", deadline: new Date("2026-08-16T11:00:00Z"), createdAt: new Date("2026-08-16T09:00:00Z"), status: "PENDING" }]
    };

    await seedLabDatabase(workload);

    // Mock db.insert(schedulerRuns) to throw an error
    const originalInsert = db.insert;
    (db as any).insert = (table: any) => {
      if (table === schedulerRuns) {
        return {
          values: () => { throw new Error("SIMULATED_DB_LOGGING_FAILURE"); }
        };
      }
      return originalInsert.call(db, table);
    };

    try {
      await runPolicyExperiment("META", workload);
    } finally {
      (db as any).insert = originalInsert;
    }

    // Scheduling should succeed despite observability failure
    const resCount = await db.select({ count: sql`count(*)` }).from(reservations);
    assert.strictEqual(Number(resCount[0]!.count), 1, "Reservation should still be committed");

    // No run trace due to failure
    const runs = await db.select().from(schedulerRuns);
    assert.strictEqual(runs.length, 0, "No run logged due to error");
  });

  it("Failure 5.5.8 - Partial execution isolates failures (Task A success, B fails, C success)", async () => {
    await resetLabDatabase();

    const workload: GeneratedWorkload = {
      satellites: [{ id: "11111111-1111-1111-1111-111111111113", noradId: 99993, name: "Sat3" }],
      stations: [{ id: "22222222-2222-2222-2222-222222222224", name: "Stn3" }],
      windows: [
        { id: "33333333-3333-3333-3333-333333333333", satelliteId: "11111111-1111-1111-1111-111111111113", groundStationId: "22222222-2222-2222-2222-222222222224", aos: new Date("2026-08-16T10:00:00Z"), los: new Date("2026-08-16T10:10:00Z"), durationSeconds: 600, maxElevationDeg: 90 },
        { id: "33333333-3333-3333-3333-333333333334", satelliteId: "11111111-1111-1111-1111-111111111113", groundStationId: "22222222-2222-2222-2222-222222222224", aos: new Date("2026-08-16T11:00:00Z"), los: new Date("2026-08-16T11:10:00Z"), durationSeconds: 600, maxElevationDeg: 90 }
      ] as any,
      tasks: [
        { id: "44444444-4444-4444-4444-444444444443", satelliteId: "11111111-1111-1111-1111-111111111113", priority: 1, durationSeconds: 60, windowId: "33333333-3333-3333-3333-333333333333", deadline: new Date("2026-08-16T12:00:00Z"), createdAt: new Date("2026-08-16T09:00:00Z"), status: "PENDING" },
        { id: "44444444-4444-4444-4444-444444444444", satelliteId: "11111111-1111-1111-1111-111111111113", priority: 1, durationSeconds: 99999, windowId: "33333333-3333-3333-3333-333333333333", deadline: new Date("2026-08-16T12:00:00Z"), createdAt: new Date("2026-08-16T09:00:00Z"), status: "PENDING" }, // Impossible duration
        { id: "44444444-4444-4444-4444-444444444445", satelliteId: "11111111-1111-1111-1111-111111111113", priority: 1, durationSeconds: 60, windowId: "33333333-3333-3333-3333-333333333334", deadline: new Date("2026-08-16T12:00:00Z"), createdAt: new Date("2026-08-16T09:00:00Z"), status: "PENDING" }
      ]
    };

    await seedLabDatabase(workload);

    // Run scheduling
    await runPolicyExperiment("META", workload);

    const tsks = await db.select().from(missionTasks).orderBy(missionTasks.id);
    const t1 = tsks.find(t => t.id === "44444444-4444-4444-4444-444444444443");
    const t2 = tsks.find(t => t.id === "44444444-4444-4444-4444-444444444444");
    const t3 = tsks.find(t => t.id === "44444444-4444-4444-4444-444444444445");

    assert.strictEqual(t1!.status, "SCHEDULED");
    assert.strictEqual(t2!.status, "PENDING"); // Impossible duration stays PENDING in DB
    assert.strictEqual(t3!.status, "SCHEDULED");

    const res = await db.select().from(reservations);
    assert.strictEqual(res.length, 2, "Only A and C should have reservations");
  });
});
