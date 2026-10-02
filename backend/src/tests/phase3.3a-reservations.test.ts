import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../app";
import { db } from "../db/client";
import { eq } from "drizzle-orm";
import { satelliteOrbitalData, users, satellites, groundStations, contactWindows, missionTasks, reservations } from "../db/schema";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";

let operatorToken: string;
let viewerToken: string;
let testTaskId: string;
let testContactWindowId: string;
let testSatId: string;
let testStationId: string;

beforeAll(async () => {
  // Create users
  const opHash = await bcrypt.hash("pass", 10);
  const [operator] = await db.insert(users).values({
    email: `operator_res_${Date.now()}@test.com`,
    passwordHash: opHash,
    role: "OPERATOR",
  }).returning();

  const viewHash = await bcrypt.hash("pass", 10);
  const [viewer] = await db.insert(users).values({
    email: `viewer_res_${Date.now()}@test.com`,
    passwordHash: viewHash,
    role: "VIEWER",
  }).returning();

  operatorToken = jwt.sign({ sub: operator.id, role: operator.role }, env.jwtSecret || "", { expiresIn: "1h" } as jwt.SignOptions);
  viewerToken = jwt.sign({ sub: viewer.id, role: viewer.role }, env.jwtSecret || "", { expiresIn: "1h" } as jwt.SignOptions);

  // Setup basic relational data
  const [sat] = await db.insert(satellites).values({
    name: `ResSat-${Date.now()}`,
    noradId: Date.now() % 100000,
    status: "ACTIVE",
  }).returning();
  testSatId = sat.id;

  const [gs] = await db.insert(groundStations).values({
    name: "ResGS",
    code: `GS-${Date.now() % 100000}`,
    latitude: 0,
    longitude: 0,
    elevation: 0,
    minimumElevationDeg: 10,
    status: "AVAILABLE"
  }).returning();
  testStationId = gs.id;

  // Contact window
  const [od] = await db.insert(satelliteOrbitalData).values({ satelliteId: sat.id, source: 'CELESTRAK', tleLine1: '1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997', tleLine2: '2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495', tleEpoch: new Date(), receivedAt: new Date() }).returning();

  const aos = new Date(Date.now() + 1000000); // Future
  const los = new Date(aos.getTime() + 15 * 60000); // 15 mins later
  const [cw] = await db.insert(contactWindows).values({
    satelliteId: sat.id,
    groundStationId: gs.id,
    orbitalDataId: od.id,
    maxElevationDeg: 45,
    durationSeconds: 900,
    aos,
    los,
    status: "UPCOMING"
  }).returning();
  testContactWindowId = cw.id;

  // Task
  const [task] = await db.insert(missionTasks).values({
    satelliteId: sat.id,
    name: "Res Task",
    priority: 1,
    durationSeconds: 300,
    deadline: new Date(Date.now() + 86400000),
    status: "PENDING"
  }).returning();
  testTaskId = task.id;
});

describe("Phase 3.3a - Reservation API Skeleton", () => {
  it("GET /api/reservations without token -> 401", async () => {
    const res = await request(app).get("/api/reservations");
    expect(res.status).toBe(401);
  });

  it("VIEWER -> GET /api/reservations -> allowed", async () => {
    const res = await request(app)
      .get("/api/reservations")
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("VIEWER -> POST /api/reservations/preview -> 403", async () => {
    const res = await request(app)
      .post("/api/reservations/preview")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({
        taskId: testTaskId,
        contactWindowId: testContactWindowId,
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 60000).toISOString()
      });
    expect(res.status).toBe(403);
  });

  it("OPERATOR -> POST /api/reservations/preview -> allowed (but might be invalid)", async () => {
    const res = await request(app)
      .post("/api/reservations/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        taskId: testTaskId,
        contactWindowId: testContactWindowId,
        startTime: new Date(Date.now() - 100000).toISOString(),
        endTime: new Date(Date.now() - 50000).toISOString()
      });
    expect(res.status).toBe(200); // Successful evaluation
    expect(res.body.valid).toBe(false);
  });

  it("Test Validation failures (missing fields) -> 400", async () => {
    const res = await request(app)
      .post("/api/reservations/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        taskId: testTaskId
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("Test end < start -> 400", async () => {
    const res = await request(app)
      .post("/api/reservations/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        taskId: testTaskId,
        contactWindowId: testContactWindowId,
        startTime: new Date(Date.now()).toISOString(),
        endTime: new Date(Date.now() - 60000).toISOString()
      });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toContain("endTime must be after startTime");
  });

  it("Test OUTSIDE_CONTACT_WINDOW: before AOS", async () => {
    const cw = await db.select().from(contactWindows).where(eq(contactWindows.id, testContactWindowId));
    const aos = cw[0].aos.getTime();

    const res = await request(app)
      .post("/api/reservations/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        taskId: testTaskId,
        contactWindowId: testContactWindowId,
        startTime: new Date(aos - 120000).toISOString(),
        endTime: new Date(aos + 300000).toISOString() // 09:58 - 10:05 scenario
      });
    
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors[0].code).toBe("OUTSIDE_CONTACT_WINDOW");
  });

  it("Test OUTSIDE_CONTACT_WINDOW: after LOS", async () => {
    const cw = await db.select().from(contactWindows).where(eq(contactWindows.id, testContactWindowId));
    const los = cw[0].los.getTime();

    const res = await request(app)
      .post("/api/reservations/preview")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        taskId: testTaskId,
        contactWindowId: testContactWindowId,
        startTime: new Date(los - 300000).toISOString(),
        endTime: new Date(los + 300000).toISOString() // 10:05 - 10:20 scenario
      });
    
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors[0].code).toBe("OUTSIDE_CONTACT_WINDOW");
  });

  it("Test GET /api/mission-tasks/:id/contact-windows", async () => {
    const res = await request(app)
      .get(`/api/mission-tasks/${testTaskId}/contact-windows`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].satelliteId).toBe(testSatId);
  });

});
