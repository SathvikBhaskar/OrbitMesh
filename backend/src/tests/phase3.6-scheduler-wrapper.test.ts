import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../db/client";
import { users, scheduleVersions, scheduleAuditLog, reservations, scheduleProposals, missionTasks, contactWindows, groundStations, satellites, satelliteOrbitalData } from "../db/schema";
import request from "supertest";
import { app } from "../app";
import { eq, sql, and } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

const TEST_SECRET = process.env.JWT_SECRET || "test-secret";

describe("Phase 3.6 - Scheduler Wrapper + Preview/Commit", () => {
  let operatorToken: string;
  let viewerToken: string;
  let operatorId: string;
  let viewerId: string;
  
  let testSatId: string;
  let testGsId: string;
  let cwAId: string;
  let cwBId: string;
  let taskAId: string; // Locked
  let taskBId: string; // Unlocked automated
  let taskCId: string; // Unlocked manual
  let taskDId: string; // Pending
  let testOrbitalDataId: string;

  // Setup exactly like the user's diagram
  beforeAll(async () => {
    // 1. Create users
    const [op] = await db.insert(users).values({
      email: `operator36-${Date.now()}@test.com`,
      passwordHash: "hash",
      role: "OPERATOR",
      firstName: "Op",
      lastName: "Test"
    }).returning();
    operatorId = op.id;
    operatorToken = jwt.sign({ sub: op.id, role: "OPERATOR" }, env.jwtSecret);

    const [vi] = await db.insert(users).values({
      email: `viewer36-${Date.now()}@test.com`,
      passwordHash: "hash",
      role: "VIEWER",
      firstName: "View",
      lastName: "Test"
    }).returning();
    viewerId = vi.id;
    viewerToken = jwt.sign({ sub: vi.id, role: "VIEWER" }, env.jwtSecret);

    // 2. Base infrastructure
    const [sat] = await db.insert(satellites).values({
      noradId: 99936 + (Date.now() % 10000),
      name: "TestSat3.6",
      type: "LEO",
      status: "ACTIVE"
    }).returning();
    testSatId = sat.id;

    const [gs] = await db.insert(groundStations).values({
      code: `TEST-GS-3.6-${Date.now()}`,
      name: "TestGS3.6",
      latitude: 0,
      longitude: 0,
      altitudeM: 0,
      minimumElevationDeg: 5,
      status: "AVAILABLE"
    }).returning();
    testGsId = gs.id;

    const [od] = await db.insert(satelliteOrbitalData).values({
      satelliteId: testSatId,
      source: 'CELESTRAK',
      tleLine1: '1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997',
      tleLine2: '2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495',
      tleEpoch: new Date(),
      receivedAt: new Date()
    }).returning();
    testOrbitalDataId = od.id;

    // 3. Contact windows
    const aosA = new Date(Date.now() + 1000000);
    const losA = new Date(aosA.getTime() + 600000); // 10 mins
    const [cwA] = await db.insert(contactWindows).values({
      satelliteId: testSatId,
      groundStationId: testGsId,
      orbitalDataId: od.id,
      aos: aosA,
      los: losA,
      durationSeconds: 600,
      maxElevationDeg: 45,
      status: "UPCOMING"
    }).returning();
    cwAId = cwA.id;

    const aosB = new Date(Date.now() + 2000000);
    const losB = new Date(aosB.getTime() + 600000); // 10 mins
    const [cwB] = await db.insert(contactWindows).values({
      satelliteId: testSatId,
      groundStationId: testGsId,
      orbitalDataId: od.id,
      aos: aosB,
      los: losB,
      durationSeconds: 600,
      maxElevationDeg: 45,
      status: "UPCOMING"
    }).returning();
    cwBId = cwB.id;

    // 4. Create tasks and reservations
    // Task A: Locked
    const [taskA] = await db.insert(missionTasks).values({
      satelliteId: testSatId,
      name: "Task A Locked",
      type: "IMAGING",
      priority: 3,
      status: "SCHEDULED",
      windowAos: aosA,
      windowLos: losA,
      durationSeconds: 120,
      deadline: new Date(losA.getTime() + 10000)
    }).returning();
    taskAId = taskA.id;

    await db.insert(reservations).values({
      missionTaskId: taskAId,
      contactWindowId: cwAId,
      groundStationId: testGsId,
      satelliteId: testSatId,
      windowAos: aosA,
      windowLos: losA,
      taskDurationSeconds: 120,
      allocatedStart: new Date(aosA.getTime() + 1000),
      allocatedEnd: new Date(aosA.getTime() + 121000),
      source: "MANUAL",
      locked: true,
      status: "PENDING"
    });

    // Task B: Unlocked AUTOMATED
    const [taskB] = await db.insert(missionTasks).values({
      satelliteId: testSatId,
      name: "Task B Auto",
      type: "IMAGING",
      priority: 1,
      status: "SCHEDULED",
      windowAos: aosB,
      windowLos: losB,
      durationSeconds: 60,
      deadline: new Date(losB.getTime() + 10000)
    }).returning();
    taskBId = taskB.id;

    await db.insert(reservations).values({
      missionTaskId: taskBId,
      contactWindowId: cwBId,
      groundStationId: testGsId,
      satelliteId: testSatId,
      windowAos: aosB,
      windowLos: losB,
      taskDurationSeconds: 60,
      allocatedStart: new Date(aosB.getTime() + 1000),
      allocatedEnd: new Date(aosB.getTime() + 61000),
      source: "AUTOMATED",
      locked: false,
      status: "PENDING"
    });

    // Task C: Pending
    const [taskC] = await db.insert(missionTasks).values({
      satelliteId: testSatId,
      name: "Task C Pending",
      type: "IMAGING",
      priority: 5,
      status: "PENDING",
      windowAos: aosB,
      windowLos: losB,
      durationSeconds: 120,
      deadline: new Date(losB.getTime() + 10000) // same window as task B, but higher priority. Might pre-empt!
    }).returning();
    taskCId = taskC.id;

    // Task D: MANUAL + UNLOCKED
    // This should NOT be deleted by the scheduler
    const aosD = new Date(Date.now() + 10000 * 60 * 1000);
    const losD = new Date(aosD.getTime() + 600000);
    const [cwD] = await db.insert(contactWindows).values({
      groundStationId: testGsId,
      satelliteId: testSatId,
      orbitalDataId: testOrbitalDataId,
      aos: aosD,
      los: losD,
      durationSeconds: 600,
      maxElevationDeg: 45,
      status: "AVAILABLE"
    }).returning();

    const [taskD] = await db.insert(missionTasks).values({
      satelliteId: testSatId,
      name: "Task D Manual Unlocked",
      type: "IMAGING",
      priority: 1,
      status: "SCHEDULED",
      windowAos: aosD,
      windowLos: losD,
      durationSeconds: 60,
      deadline: new Date(losD.getTime() + 10000)
    }).returning();
    taskDId = taskD.id;
    
    await db.insert(reservations).values({
      missionTaskId: taskD.id,
      contactWindowId: cwD.id,
      groundStationId: testGsId,
      satelliteId: testSatId,
      windowAos: aosD,
      windowLos: losD,
      taskDurationSeconds: 60,
      allocatedStart: new Date(aosD.getTime() + 1000),
      allocatedEnd: new Date(aosD.getTime() + 61000),
      source: "MANUAL",
      locked: false,
      status: "PENDING"
    });
  });

  afterAll(async () => {
    // cleanup
    await db.delete(reservations).where(eq(reservations.satelliteId, testSatId));
    await db.delete(missionTasks).where(eq(missionTasks.satelliteId, testSatId));
    await db.delete(contactWindows).where(eq(contactWindows.satelliteId, testSatId));
    await db.delete(satelliteOrbitalData).where(eq(satelliteOrbitalData.satelliteId, testSatId));
    await db.delete(satellites).where(eq(satellites.id, testSatId));
    await db.delete(groundStations).where(eq(groundStations.id, testGsId));
    await db.delete(scheduleProposals);
    // Cannot delete users because schedule_audit_log prevents deletion via trigger
    // and holds a FK to users. This is acceptable for test data.
  });

  async function sendPreview(version: number, token = operatorToken) {
    return await request(app)
      .post("/api/scheduler/preview")
      .set("Authorization", `Bearer ${token}`)
      .send({ scheduleVersion: version });
  }

  async function sendCommit(proposedReservations: any[], version: number, token = operatorToken) {
    return await request(app)
      .post("/api/scheduler/commit")
      .set("Authorization", `Bearer ${token}`)
      .send({ proposedReservations, scheduleVersion: version });
  }

  async function getCurrentVersion() {
    const res = await db.select().from(scheduleVersions).limit(1);
    return res[0]?.version || 0;
  }

  let initialVersion = 0;
  let validProposedReservations: any[] = [];

  it("1. Viewer preview -> 403", async () => {
    initialVersion = await getCurrentVersion();
    const res = await sendPreview(initialVersion, viewerToken);
    expect(res.status).toBe(403);
  });

  it("2. No authentication -> 401", async () => {
    const v = await getCurrentVersion();
    const res = await sendPreview(v, "invalid");
    expect(res.status).toBe(401);
  });

  it("3. Operator can preview, zero DB mutation occurs", async () => {
    initialVersion = await getCurrentVersion();
    const countBefore = await db.select({ count: sql<number>`count(*)` }).from(reservations).where(eq(reservations.satelliteId, testSatId));
    
    const res = await sendPreview(initialVersion);
    expect(res.status).toBe(200);
    const body = res.body;

    expect(body.scheduleVersion).toBe(initialVersion);
    expect(body.proposedReservations).toBeDefined();
    const lockedTaskA = body.lockedReservations.find((r: any) => r.missionTaskId === taskAId);
    expect(lockedTaskA).toBeDefined();
    expect(lockedTaskA.missionTaskId).toBe(taskAId); // Task A is locked

    validProposedReservations = body.proposedReservations;

    const countAfter = await db.select({ count: sql<number>`count(*)` }).from(reservations).where(eq(reservations.satelliteId, testSatId));
    expect(countBefore[0].count).toBe(countAfter[0].count); // ZERO MUTATION
  });

  it("4. Stale commit -> 409 SCHEDULE_VERSION_CONFLICT", async () => {
    const res = await sendCommit(validProposedReservations, initialVersion - 1);
    expect(res.status).toBe(409);
    const body = res.body;
    expect(body.error).toBe("Schedule version conflict");
  });

  it("5. Valid proposal commit -> 200, DB mutates, version increments", async () => {
    const res = await sendCommit(validProposedReservations, initialVersion);
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.success).toBe(true);

    const newVersion = await getCurrentVersion();
    expect(newVersion).toBe(initialVersion + 1);

    // Verify DB state
    const lockedRes = await db.select().from(reservations).where(eq(reservations.missionTaskId, taskAId));
    expect(lockedRes.length).toBe(1);
    expect(lockedRes[0].locked).toBe(true);
    expect(lockedRes[0].source).toBe("MANUAL");

    // Task B and C should be scheduled and source AUTOMATED
    const autoRes = await db.select().from(reservations)
      .where(and(eq(reservations.source, "AUTOMATED"), eq(reservations.satelliteId, testSatId)));
    expect(autoRes.length).toBe(2);

    // Verify MANUAL + UNLOCKED survived
    const manualUnlockedRes = await db.select().from(reservations).where(eq(reservations.missionTaskId, taskDId));
    expect(manualUnlockedRes.length).toBe(1);
    expect(manualUnlockedRes[0].locked).toBe(false);
    expect(manualUnlockedRes[0].source).toBe("MANUAL");
    
    const taskC = await db.select().from(missionTasks).where(eq(missionTasks.id, taskCId));
    expect(taskC[0].status).toBe("SCHEDULED");
  });
});
