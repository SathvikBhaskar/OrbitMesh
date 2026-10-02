import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../app";
import { db } from "../db/client";
import { eq } from "drizzle-orm";
import { satelliteOrbitalData, users, satellites, groundStations, contactWindows, missionTasks, reservations } from "../db/schema";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import request from "supertest";
import { env } from "../config/env";

describe("Phase 3.3b - Validated Reservation Persistence", () => {
  let operatorToken: string;
  let viewerToken: string;
  let testSatId: string;
  let testStationId: string;
  let testCwId: string;
  let testTaskId: string;
  
  let validAos: Date;
  let validLos: Date;

  beforeAll(async () => {
    // 1. Create tokens
    const [operator] = await db.insert(users).values({
      email: `op33b_${Date.now()}@test.com`,
      passwordHash: await bcrypt.hash("password", 10),
      role: "OPERATOR"
    }).returning();
    operatorToken = jwt.sign({ sub: operator.id, role: operator.role }, env.jwtSecret, { expiresIn: "1h" });

    const [viewer] = await db.insert(users).values({
      email: `viewer33b_${Date.now()}@test.com`,
      passwordHash: await bcrypt.hash("password", 10),
      role: "VIEWER"
    }).returning();
    viewerToken = jwt.sign({ sub: viewer.id, role: viewer.role }, env.jwtSecret, { expiresIn: "1h" });

    // 2. Create Satellite and Ground Station
    const [sat] = await db.insert(satellites).values({
      noradId: 35544 + Date.now() % 10000,
      name: "PersistSat",
      type: "LEO",
      status: "ACTIVE"
    }).returning();
    testSatId = sat.id;

    const [gs] = await db.insert(groundStations).values({
      name: "PersistGS",
      code: `PGS-${Date.now() % 10000}`,
      latitude: 0,
      longitude: 0,
      elevation: 0,
      minimumElevationDeg: 10,
      status: "AVAILABLE"
    }).returning();
    testStationId = gs.id;

    // 3. Orbital Data
    const [od] = await db.insert(satelliteOrbitalData).values({
      satelliteId: sat.id,
      source: 'CELESTRAK',
      tleLine1: '1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997',
      tleLine2: '2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495',
      tleEpoch: new Date(),
      receivedAt: new Date()
    }).returning();

    // 4. Contact Windows
    const now = Date.now();
    validAos = new Date(now + 1000000);
    validLos = new Date(validAos.getTime() + 15 * 60000); // 15 mins window
    
    const [cw] = await db.insert(contactWindows).values({
      satelliteId: sat.id,
      groundStationId: gs.id,
      orbitalDataId: od.id,
      aos: validAos,
      los: validLos,
      maxElevationDeg: 45,
      durationSeconds: 900,
    }).returning();
    testCwId = cw.id;

    // 5. Mission Task
    const [task] = await db.insert(missionTasks).values({
      satelliteId: sat.id,
      name: "Persist Task",
      priority: 1,
      durationSeconds: 300, // 5 min requirement
      deadline: new Date(validLos.getTime() + 60000), // Deadline is just after LOS
      status: "PENDING"
    }).returning();
    testTaskId = task.id;
  });

  const sendPost = async (body: any, token: string = operatorToken) => {
    return request(app)
      .post("/api/reservations")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
  };

  it("Viewer creates reservation -> 403", async () => {
    const res = await sendPost({
      taskId: testTaskId,
      contactWindowId: testCwId,
      startTime: new Date(validAos.getTime() + 60000).toISOString(),
      endTime: new Date(validAos.getTime() + 60000 + 300000).toISOString(),
    }, viewerToken);
    expect(res.status).toBe(403);
  });

  it("Valid reservation -> 201 + persisted with source=MANUAL and locked=false", async () => {
    const resvCountBefore = await db.select().from(reservations).where(eq(reservations.satelliteId, testSatId));
    
    const res = await sendPost({
      taskId: testTaskId,
      contactWindowId: testCwId,
      startTime: new Date(validAos.getTime() + 60000).toISOString(),
      endTime: new Date(validAos.getTime() + 60000 + 300000).toISOString(),
    });
    
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.source).toBe("MANUAL");
    expect(res.body.locked).toBe(false);

    const resvCountAfter = await db.select().from(reservations).where(eq(reservations.satelliteId, testSatId));
    expect(resvCountAfter.length).toBe(resvCountBefore.length + 1);

    // Clean up to allow next tests
    await db.delete(reservations).where(eq(reservations.id, res.body.id));
  });

  it("Invalid reservation (Deadline violation) -> 422 + no row", async () => {
    await db.update(missionTasks).set({ deadline: new Date(validAos.getTime() - 60000) }).where(eq(missionTasks.id, testTaskId));
    const resvCountBefore = await db.select().from(reservations).where(eq(reservations.satelliteId, testSatId));

    const res = await sendPost({
      taskId: testTaskId,
      contactWindowId: testCwId,
      startTime: new Date(validAos.getTime() + 60000).toISOString(),
      endTime: new Date(validAos.getTime() + 60000 + 300000).toISOString(),
    });

    expect(res.status).toBe(422);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.some((e: any) => e.code === "DEADLINE_MISSED")).toBe(true);

    const resvCountAfter = await db.select().from(reservations).where(eq(reservations.satelliteId, testSatId));
    expect(resvCountAfter.length).toBe(resvCountBefore.length);

    await db.update(missionTasks).set({ deadline: new Date(validLos.getTime() + 60000) }).where(eq(missionTasks.id, testTaskId));
  });

  it("Satellite conflict -> rejected + no row", async () => {
    const startTime = new Date(validAos.getTime() + 60000);
    const endTime = new Date(startTime.getTime() + 300000);

    // Create manual active reservation
    await db.insert(reservations).values({
      missionTaskId: testTaskId,
      contactWindowId: testCwId,
      groundStationId: testStationId,
      satelliteId: testSatId,
      windowAos: validAos,
      windowLos: validLos,
      taskDurationSeconds: 300,
      allocatedStart: new Date(startTime.getTime() - 10000),
      allocatedEnd: new Date(startTime.getTime() - 10000 + 300000),
      status: "PENDING",
      source: "MANUAL",
      locked: false
    });

    const resvCountBefore = await db.select().from(reservations).where(eq(reservations.satelliteId, testSatId));

    const res = await sendPost({
      taskId: testTaskId,
      contactWindowId: testCwId,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
    });

    expect(res.status).toBe(422);
    expect(res.body.errors.some((e: any) => e.code === "SATELLITE_CONFLICT")).toBe(true);

    const resvCountAfter = await db.select().from(reservations).where(eq(reservations.satelliteId, testSatId));
    expect(resvCountAfter.length).toBe(resvCountBefore.length); // no NEW row

    // Clean up
    await db.delete(reservations).where(eq(reservations.satelliteId, testSatId));
  });

  it("Duplicate/conflicting concurrent insert -> only one succeeds", async () => {
    const startTime = new Date(validAos.getTime() + 100000);
    const endTime = new Date(startTime.getTime() + 300000);

    const payload1 = {
      taskId: testTaskId,
      contactWindowId: testCwId,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
    };
    
    // We create a second task to try and reserve exactly the same window simultaneously
    const [task2] = await db.insert(missionTasks).values({
      satelliteId: testSatId,
      name: "Concurrent Task",
      priority: 1,
      durationSeconds: 300,
      deadline: new Date(validLos.getTime() + 60000),
      status: "PENDING"
    }).returning();

    const payload2 = {
      taskId: task2.id,
      contactWindowId: testCwId,
      startTime: startTime.toISOString(), // exact same time as payload1
      endTime: endTime.toISOString(),
    };

    const resvCountBefore = await db.select().from(reservations).where(eq(reservations.satelliteId, testSatId));

    // Fire both concurrently
    const [res1, res2] = await Promise.all([
      sendPost(payload1),
      sendPost(payload2)
    ]);

    // One should succeed (201), the other should fail with serialization conflict (409) or overlap (422) depending on timing
    const statuses = [res1.status, res2.status].sort();
    
    // Actually, one should be 201, and the other could be 409 (serialization conflict) or 422 (if postgres runs them serially and the second fails validation)
    expect(statuses).toEqual(expect.arrayContaining([201]));
    expect(statuses[0] === 409 || statuses[0] === 422 || statuses[1] === 409 || statuses[1] === 422).toBe(true);

    const resvCountAfter = await db.select().from(reservations).where(eq(reservations.satelliteId, testSatId));
    // Exactly ONE row should be added
    expect(resvCountAfter.length).toBe(resvCountBefore.length + 1);

    // Cleanup
    await db.delete(reservations).where(eq(reservations.satelliteId, testSatId));
  });
});
