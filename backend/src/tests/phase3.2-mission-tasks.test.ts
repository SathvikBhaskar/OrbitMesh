import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../app";
import { db } from "../db/client";
import { users, satellites, missionTasks, reservations } from "../db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import request from "supertest";

let operatorToken: string;
let viewerToken: string;
let testSatelliteId: string;

beforeAll(async () => {
  // Create users
  const opHash = await bcrypt.hash("pass", 10);
  const [operator] = await db.insert(users).values({
    email: `operator_task_${Date.now()}@test.com`,
    passwordHash: opHash,
    role: "OPERATOR",
  }).returning();

  const viewHash = await bcrypt.hash("pass", 10);
  const [viewer] = await db.insert(users).values({
    email: `viewer_task_${Date.now()}@test.com`,
    passwordHash: viewHash,
    role: "VIEWER",
  }).returning();

  operatorToken = jwt.sign({ sub: operator.id, role: operator.role }, env.jwtSecret, { expiresIn: "1h" });
  viewerToken = jwt.sign({ sub: viewer.id, role: viewer.role }, env.jwtSecret, { expiresIn: "1h" });

  // Create a satellite
  const [sat] = await db.insert(satellites).values({
    name: "TaskSat",
    noradId: 99991 + (Date.now() % 10000),
    status: "ACTIVE",
  }).returning();
  testSatelliteId = sat.id;
});

describe("Phase 3.2 - Mission Task CRUD & State Machine", () => {
  let pendingTaskId: string;

  it("OPERATOR creates task -> 201", async () => {
    const res = await request(app)
      .post("/api/mission-tasks")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        satelliteId: testSatelliteId,
        name: "Op Task",
        priority: 1,
        durationSeconds: 300,
        deadline: new Date(Date.now() + 86400000).toISOString(),
      });
    expect(res.status).toBe(201);
    pendingTaskId = res.body.id;
    expect(res.body.status).toBe("PENDING");
  });

  it("VIEWER creates task -> 403", async () => {
    const res = await request(app)
      .post("/api/mission-tasks")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({
        satelliteId: testSatelliteId,
        name: "Viewer Task",
        priority: 2,
        durationSeconds: 300,
        deadline: new Date(Date.now() + 86400000).toISOString(),
      });
    expect(res.status).toBe(403);
  });

  it("OPERATOR edits PENDING -> success", async () => {
    const res = await request(app)
      .patch(`/api/mission-tasks/${pendingTaskId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ priority: 2 });
    expect(res.status).toBe(200);
    expect(res.body.priority).toBe(2);
  });

  it("OPERATOR cancels PENDING -> success", async () => {
    const res = await request(app)
      .patch(`/api/mission-tasks/${pendingTaskId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ status: "CANCELLED" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");
  });

  it("OPERATOR edits CANCELLED -> 409", async () => {
    const res = await request(app)
      .patch(`/api/mission-tasks/${pendingTaskId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ priority: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("TASK_NOT_EDITABLE");
  });

  it("OPERATOR edits SCHEDULED -> 409", async () => {
    // Manually push a task to SCHEDULED
    const [scheduledTask] = await db.insert(missionTasks).values({
      satelliteId: testSatelliteId,
      name: "Sched Task",
      priority: 1,
      durationSeconds: 300,
      deadline: new Date(Date.now() + 86400000),
      status: "SCHEDULED"
    }).returning();

    const res = await request(app)
      .patch(`/api/mission-tasks/${scheduledTask.id}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ priority: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("TASK_NOT_EDITABLE");
  });

  it("OPERATOR edits COMPLETED -> 409", async () => {
    // Manually push a task to COMPLETED
    const [completedTask] = await db.insert(missionTasks).values({
      satelliteId: testSatelliteId,
      name: "Comp Task",
      priority: 1,
      durationSeconds: 300,
      deadline: new Date(Date.now() + 86400000),
      status: "COMPLETED"
    }).returning();

    const res = await request(app)
      .patch(`/api/mission-tasks/${completedTask.id}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ priority: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("TASK_NOT_EDITABLE");
  });

  it("Invalid payload creates -> 400", async () => {
    const res = await request(app)
      .post("/api/mission-tasks")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        satelliteId: testSatelliteId,
        // missing name, priority
      });
    expect(res.status).toBe(400);
  });
});
