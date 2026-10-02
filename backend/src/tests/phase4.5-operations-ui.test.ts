import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../db/client";
import {
  users,
  scheduleVersions,
  scheduleAuditLog,
  reservations,
  missionTasks,
  contactWindows,
  groundStations,
  satellites,
  satelliteOrbitalData,
} from "../db/schema";
import request from "supertest";
import { app } from "../app";
import { eq, inArray, and } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

describe("Phase 4.5 - Operations UI Integration & Policy Control", () => {
  let operatorToken: string;
  let viewerToken: string;
  let operatorId: string;
  let viewerId: string;

  let satId: string;
  let gsId: string;
  let odId: string;
  let winId: string;
  let taskId: string;

  const baseTime = Date.now() + 10000000;

  beforeAll(async () => {
    // 1. Create operator and viewer users
    const [op] = await db
      .insert(users)
      .values({
        email: `op45-${Date.now()}@test.com`,
        passwordHash: "hash",
        role: "OPERATOR",
      })
      .returning();
    operatorId = op.id;
    operatorToken = jwt.sign({ sub: op.id, role: "OPERATOR" }, env.jwtSecret);

    const [vi] = await db
      .insert(users)
      .values({
        email: `view45-${Date.now()}@test.com`,
        passwordHash: "hash",
        role: "VIEWER",
      })
      .returning();
    viewerId = vi.id;
    viewerToken = jwt.sign({ sub: vi.id, role: "VIEWER" }, env.jwtSecret);

    // 2. Base infrastructure
    const [sat] = await db
      .insert(satellites)
      .values({
        noradId: 88450 + (Date.now() % 10000),
        name: "Sat-Phase4.5",
        type: "LEO",
        status: "ACTIVE",
      })
      .returning();
    satId = sat.id;

    const [gs] = await db
      .insert(groundStations)
      .values({
        code: `GS-45-${Date.now() % 10000}`,
        name: "GS-Phase4.5",
        latitude: 13.0827,
        longitude: 80.2707,
        altitudeM: 50,
        minimumElevationDeg: 5,
        status: "AVAILABLE",
        supportedFrequencyBands: ["S_BAND", "X_BAND"],
        maxConcurrentContacts: 2,
        maxDataRateMbps: 150.0,
      })
      .returning();
    gsId = gs.id;

    const [od] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: satId,
        source: "CELESTRAK",
        tleLine1: "1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997",
        tleLine2: "2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495",
        tleEpoch: new Date(),
        receivedAt: new Date(),
      })
      .returning();
    odId = od.id;

    const [win] = await db
      .insert(contactWindows)
      .values({
        satelliteId: satId,
        groundStationId: gsId,
        orbitalDataId: odId,
        aos: new Date(baseTime),
        los: new Date(baseTime + 600000),
        durationSeconds: 600,
        maxElevationDeg: 75,
        status: "AVAILABLE",
      })
      .returning();
    winId = win.id;

    const [task] = await db
      .insert(missionTasks)
      .values({
        satelliteId: satId,
        name: "Phase 4.5 Task",
        priority: 8,
        durationSeconds: 300,
        deadline: new Date(baseTime + 1200000),
        status: "PENDING",
        requiredFrequencyBand: "X_BAND",
        minDataRateMbps: 100.0,
      })
      .returning();
    taskId = task.id;

    // Ensure scheduleVersions row exists
    const v = await db.select().from(scheduleVersions).limit(1);
    if (v.length === 0) {
      await db.insert(scheduleVersions).values({ version: 1 });
    }
  });

  afterAll(async () => {
    await db.delete(reservations).where(eq(reservations.satelliteId, satId));
    await db.delete(missionTasks).where(eq(missionTasks.id, taskId));
    await db.delete(contactWindows).where(eq(contactWindows.id, winId));
    await db.delete(satelliteOrbitalData).where(eq(satelliteOrbitalData.id, odId));
    await db.delete(satellites).where(eq(satellites.id, satId));
    await db.delete(groundStations).where(eq(groundStations.id, gsId));
  });

  describe("Backend Contract: POST /api/scheduler/preview", () => {
    it("1. Preview with policy HYBRID returns 200 with metrics and score breakdowns", async () => {
      const verRes = await db.select().from(scheduleVersions).limit(1);
      const curVersion = verRes[0].version;

      const res = await request(app)
        .post("/api/scheduler/preview")
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({
          scheduleVersion: curVersion,
          policy: "HYBRID",
        });

      expect(res.status).toBe(200);
      expect(res.body.policy).toBe("HYBRID");
      expect(res.body.scheduleVersion).toBe(curVersion);
      expect(Array.isArray(res.body.proposedReservations)).toBe(true);
      expect(res.body.proposedReservations.length).toBeGreaterThan(0);

      // Verify standardized metrics
      expect(res.body.metrics).toBeDefined();
      expect(typeof res.body.metrics.scheduledTaskCount).toBe("number");
      expect(typeof res.body.metrics.weightedPriorityValue).toBe("number");
      expect(typeof res.body.metrics.deadlineSuccessRate).toBe("number");
      expect(typeof res.body.metrics.stationUtilizationPercent).toBe("number");

      // Verify score breakdowns
      expect(Array.isArray(res.body.scoreBreakdowns)).toBe(true);
      expect(res.body.scoreBreakdowns.length).toBeGreaterThan(0);
      const b = res.body.scoreBreakdowns[0];
      expect(b).toHaveProperty("compositeScore");
      expect(b).toHaveProperty("normPriority");
      expect(b).toHaveProperty("normUrgency");
      expect(b).toHaveProperty("normElevation");
    });

    it("2. Preview with policy PRIORITY and FCFS executes corresponding policy", async () => {
      const verRes = await db.select().from(scheduleVersions).limit(1);
      const curVersion = verRes[0].version;

      const resPriority = await request(app)
        .post("/api/scheduler/preview")
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({
          scheduleVersion: curVersion,
          policy: "PRIORITY",
        });

      expect(resPriority.status).toBe(200);
      expect(resPriority.body.policy).toBe("PRIORITY");

      const resFcfs = await request(app)
        .post("/api/scheduler/preview")
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({
          scheduleVersion: curVersion,
          policy: "FCFS",
        });

      expect(resFcfs.status).toBe(200);
      expect(resFcfs.body.policy).toBe("FCFS");
    });

    it("3. Preview is strictly non-mutating (zero database reservations created)", async () => {
      const resvsBefore = await db.select().from(reservations).where(eq(reservations.satelliteId, satId));
      expect(resvsBefore.length).toBe(0);

      const verRes = await db.select().from(scheduleVersions).limit(1);
      await request(app)
        .post("/api/scheduler/preview")
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({
          scheduleVersion: verRes[0].version,
          policy: "HYBRID",
        });

      const resvsAfter = await db.select().from(reservations).where(eq(reservations.satelliteId, satId));
      expect(resvsAfter.length).toBe(0);
    });

    it("4. Stale scheduleVersion returns 409 conflict on preview", async () => {
      const res = await request(app)
        .post("/api/scheduler/preview")
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({
          scheduleVersion: 999999,
          policy: "HYBRID",
        });

      expect(res.status).toBe(409);
    });

    it("5. VIEWER role cannot access preview (403 Forbidden)", async () => {
      const verRes = await db.select().from(scheduleVersions).limit(1);
      const res = await request(app)
        .post("/api/scheduler/preview")
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({
          scheduleVersion: verRes[0].version,
          policy: "HYBRID",
        });

      expect(res.status).toBe(403);
    });
  });

  describe("Backend Contract: POST /api/scheduler/commit with Policy Auditing", () => {
    it("6. Committing with selected policy records policy name in schedule_audit_log", async () => {
      const verRes = await db.select().from(scheduleVersions).limit(1);
      const curVersion = verRes[0].version;

      // 1. Run preview first to get proposal
      const previewRes = await request(app)
        .post("/api/scheduler/preview")
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({
          scheduleVersion: curVersion,
          policy: "HYBRID",
        });
      expect(previewRes.status).toBe(200);

      const proposed = previewRes.body.proposedReservations;
      expect(proposed.length).toBeGreaterThan(0);

      // 2. Commit proposal with policy "HYBRID"
      const commitRes = await request(app)
        .post("/api/scheduler/commit")
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({
          scheduleVersion: curVersion,
          proposedReservations: proposed,
          policy: "HYBRID",
        });

      expect(commitRes.status).toBe(200);
      expect(commitRes.body.success).toBe(true);
      expect(commitRes.body.policy).toBe("HYBRID");

      // 3. Verify schedule version was bumped
      const newVerRes = await db.select().from(scheduleVersions).limit(1);
      expect(newVerRes[0].version).toBe(curVersion + 1);

      // 4. Verify schedule_audit_log contains records with policy name
      const logs = await db
        .select()
        .from(scheduleAuditLog)
        .where(eq(scheduleAuditLog.userId, operatorId));

      expect(logs.length).toBeGreaterThan(0);

      // Check reservation audit entry
      const resvLog = logs.find((l) => l.entityType === "RESERVATION" && l.reason?.includes("HYBRID"));
      expect(resvLog).toBeDefined();
      expect(resvLog?.reason).toContain("HYBRID");
      expect((resvLog?.afterState as any)?.policy).toBe("HYBRID");

      // Check schedule-level audit entry
      const schedLog = logs.find((l) => l.entityType === "SCHEDULE");
      expect(schedLog).toBeDefined();
      expect(schedLog?.reason).toContain("HYBRID");
      expect((schedLog?.afterState as any)?.policy).toBe("HYBRID");
    });
  });
});
