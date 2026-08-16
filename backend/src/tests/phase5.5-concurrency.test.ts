import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { db } from "../db/client";
import { reservations, missionTasks, contactWindows, satelliteOrbitalData, groundStations, satellites } from "../db/schema";
import { MetaScheduler } from "../modules/meta-scheduler/meta-scheduler";
import { sql } from "drizzle-orm";
import { GeneratedWorkload } from "../modules/scheduler-lab/workload-generator";
import { resetLabDatabase, seedLabDatabase } from "../modules/scheduler-lab/policy-runner";

describe("Phase 5.5 - Concurrency and Isolation", () => {
  before(async () => {
    await resetLabDatabase();
  });

  it("Test A & C - Same task, simultaneous schedulers & different windows: exactly 1 reservation", async () => {
    await resetLabDatabase();

    const satId = "11111111-1111-1111-1111-111111111111";
    const stnId = "22222222-2222-2222-2222-222222222222";
    const win1 = "33333333-3333-3333-3333-333333333331";
    const win2 = "33333333-3333-3333-3333-333333333332";
    const taskX = "44444444-4444-4444-4444-444444444444";

    const workload: GeneratedWorkload = {
      satellites: [{ id: satId, noradId: 99994, name: "SatA" }],
      stations: [{ id: stnId, name: "StnA" }],
      windows: [
        { id: win1, satelliteId: satId, groundStationId: stnId, aos: new Date("2026-08-16T10:00:00Z"), los: new Date("2026-08-16T10:10:00Z"), durationSeconds: 600, maxElevationDeg: 90 },
        { id: win2, satelliteId: satId, groundStationId: stnId, aos: new Date("2026-08-16T11:00:00Z"), los: new Date("2026-08-16T11:10:00Z"), durationSeconds: 600, maxElevationDeg: 90 }
      ] as any,
      tasks: [
        { id: taskX, satelliteId: satId, priority: 1, durationSeconds: 60, windowId: null, deadline: new Date("2026-08-16T12:00:00Z"), status: "PENDING" }
      ]
    };

    await seedLabDatabase(workload);

    const schedulerA = new MetaScheduler(undefined, "LAB");
    const schedulerB = new MetaScheduler(undefined, "LAB");

    // Run both simultaneously
    await Promise.all([
      schedulerA.schedulePendingTasks(),
      schedulerB.schedulePendingTasks()
    ]);

    const res = await db.select().from(reservations);
    assert.strictEqual(res.length, 1, "Exactly one active reservation must exist for Task X");
  });

  it("Test B & Failure C - Different tasks, same station, overlapping interval", async () => {
    await resetLabDatabase();

    const satB1 = "11111111-1111-1111-1111-111111111112";
    const satB2 = "11111111-1111-1111-1111-111111111113";
    const stnB = "22222222-2222-2222-2222-222222222223";

    const workload: GeneratedWorkload = {
      satellites: [
        { id: satB1, noradId: 99995, name: "SatB1" },
        { id: satB2, noradId: 99996, name: "SatB2" }
      ],
      stations: [{ id: stnB, name: "StnB" }],
      windows: [
        { id: "33333333-3333-3333-3333-333333333333", satelliteId: satB1, groundStationId: stnB, aos: new Date("2026-08-16T10:00:00Z"), los: new Date("2026-08-16T10:10:00Z"), durationSeconds: 600, maxElevationDeg: 90 },
        { id: "33333333-3333-3333-3333-333333333334", satelliteId: satB2, groundStationId: stnB, aos: new Date("2026-08-16T10:00:00Z"), los: new Date("2026-08-16T10:10:00Z"), durationSeconds: 600, maxElevationDeg: 90 } // Overlapping window for same station!
      ] as any,
      tasks: [
        { id: "44444444-4444-4444-4444-444444444445", satelliteId: satB1, priority: 1, durationSeconds: 600, windowId: "33333333-3333-3333-3333-333333333333", deadline: new Date("2026-08-16T12:00:00Z"), status: "PENDING" },
        { id: "44444444-4444-4444-4444-444444444446", satelliteId: satB2, priority: 1, durationSeconds: 600, windowId: "33333333-3333-3333-3333-333333333334", deadline: new Date("2026-08-16T12:00:00Z"), status: "PENDING" }
      ]
    };

    await seedLabDatabase(workload);

    const schedulerA = new MetaScheduler(undefined, "LAB");
    const schedulerB = new MetaScheduler(undefined, "LAB");

    // Run simultaneously to trigger GiST exclusion or serialization failures
    await Promise.all([
      schedulerA.schedulePendingTasks().catch(e => null),
      schedulerB.schedulePendingTasks().catch(e => null)
    ]);

    const res = await db.select().from(reservations);
    
    // One must succeed, one must fail or shift to a non-overlapping interval
    assert.strictEqual(res.length, 1, "Only one reservation should succeed due to station overlap");
    
    const r1 = res[0]!;
    assert.ok(r1.allocatedStart < r1.allocatedEnd, "Allocated start < end");
  });

  it("Test D - Repeated invocation (Idempotency)", async () => {
    await resetLabDatabase();

    const satC = "11111111-1111-1111-1111-111111111114";
    const stnC = "22222222-2222-2222-2222-222222222224";

    const workload: GeneratedWorkload = {
      satellites: [{ id: satC, noradId: 99997, name: "SatC" }],
      stations: [{ id: stnC, name: "StnC" }],
      windows: [
        { id: "33333333-3333-3333-3333-333333333335", satelliteId: satC, groundStationId: stnC, aos: new Date("2026-08-16T10:00:00Z"), los: new Date("2026-08-16T10:10:00Z"), durationSeconds: 600, maxElevationDeg: 90 }
      ] as any,
      tasks: [
        { id: "44444444-4444-4444-4444-444444444447", satelliteId: satC, priority: 1, durationSeconds: 60, windowId: "33333333-3333-3333-3333-333333333335", deadline: new Date("2026-08-16T12:00:00Z"), status: "PENDING" }
      ]
    };

    await seedLabDatabase(workload);

    const scheduler = new MetaScheduler(undefined, "LAB");

    // Run 3 times sequentially
    await scheduler.schedulePendingTasks();
    const resCount1 = await db.select({ count: sql`count(*)` }).from(reservations);
    assert.strictEqual(Number(resCount1[0]!.count), 1);

    await scheduler.schedulePendingTasks();
    const resCount2 = await db.select({ count: sql`count(*)` }).from(reservations);
    assert.strictEqual(Number(resCount2[0]!.count), 1);

    await scheduler.schedulePendingTasks();
    const resCount3 = await db.select({ count: sql`count(*)` }).from(reservations);
    assert.strictEqual(Number(resCount3[0]!.count), 1, "Idempotency violated: reservations changed");
  });
});
