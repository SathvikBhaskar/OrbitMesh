import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../app";
import { db } from "../db/client";
import { eq, or, sql } from "drizzle-orm";
import {
  satelliteOrbitalData,
  users,
  satellites,
  groundStations,
  contactWindows,
  missionTasks,
  reservations,
  scheduleVersions,
} from "../db/schema";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import request from "supertest";
import { env } from "../config/env";
import { constraintValidator } from "../modules/reservations/constraint-validator";
import { CandidateService } from "../modules/scheduler/candidate-service";
import { PriorityScheduler } from "../modules/scheduler/priority-scheduler";
import { UrgencyScheduler } from "../modules/scheduler/urgency-scheduler";
import {
  calculateWindowSlack,
  calculateIntervalSlack,
  calculateUrgencyRatio,
  isNegativeSlack,
  isCriticalSlack,
  isAmpleSlack,
  compareUrgencyTieBreaker,
} from "../modules/scheduler/urgency";

describe("Phase 4.2 - Deadline Urgency & Slack-Time Dynamics", () => {
  let operatorToken: string;
  let viewerToken: string;

  let testSatId: string;
  let testOrbitalDataId: string;
  let testGsId: string;
  let sBandOnlyGsId: string;

  beforeAll(async () => {
    // 1. Create tokens
    const [op] = await db.insert(users).values({
      email: `op42_${Date.now()}@test.com`,
      passwordHash: await bcrypt.hash("password", 10),
      role: "OPERATOR",
    }).returning();
    operatorToken = jwt.sign({ sub: op.id, role: op.role }, env.jwtSecret, { expiresIn: "1h" });

    const [vw] = await db.insert(users).values({
      email: `vw42_${Date.now()}@test.com`,
      passwordHash: await bcrypt.hash("password", 10),
      role: "VIEWER",
    }).returning();
    viewerToken = jwt.sign({ sub: vw.id, role: vw.role }, env.jwtSecret, { expiresIn: "1h" });

    // 2. Base Satellite
    const [sat] = await db.insert(satellites).values({
      noradId: 47000 + (Date.now() % 10000),
      name: "UrgencyTestSat",
      type: "LEO",
      status: "ACTIVE",
    }).returning();
    testSatId = sat.id;

    // 3. Orbital Data
    const [od] = await db.insert(satelliteOrbitalData).values({
      satelliteId: sat.id,
      source: "CELESTRAK",
      tleLine1: "1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997",
      tleLine2: "2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495",
      tleEpoch: new Date(),
      receivedAt: new Date(),
    }).returning();
    testOrbitalDataId = od.id;

    // 4. Ground Stations
    // Multi-channel / multi-band GS
    const [gs] = await db.insert(groundStations).values({
      code: `GS42-MAIN-${Date.now() % 10000}`,
      name: "Urgency Main Station",
      latitude: 13.0827,
      longitude: 80.2707,
      altitudeM: 10,
      minimumElevationDeg: 10,
      status: "AVAILABLE",
      supportedFrequencyBands: ["S_BAND", "X_BAND"],
      maxConcurrentContacts: 1,
      maxDataRateMbps: 100.0,
    }).returning();
    testGsId = gs.id;

    // S_BAND only GS for capability enforcement
    const [sGs] = await db.insert(groundStations).values({
      code: `GS42-SBAND-${Date.now() % 10000}`,
      name: "Urgency S-Band Station",
      latitude: 12.9716,
      longitude: 77.5946,
      altitudeM: 920,
      minimumElevationDeg: 10,
      status: "AVAILABLE",
      supportedFrequencyBands: ["S_BAND"],
      maxConcurrentContacts: 1,
      maxDataRateMbps: 25.0,
    }).returning();
    sBandOnlyGsId = sGs.id;
  });

  afterAll(async () => {
    await db.delete(reservations).where(or(
      eq(reservations.satelliteId, testSatId),
      eq(reservations.groundStationId, testGsId),
      eq(reservations.groundStationId, sBandOnlyGsId)
    ));
    await db.delete(contactWindows).where(or(
      eq(contactWindows.satelliteId, testSatId),
      eq(contactWindows.groundStationId, testGsId),
      eq(contactWindows.groundStationId, sBandOnlyGsId)
    ));
    await db.delete(missionTasks).where(eq(missionTasks.satelliteId, testSatId));
    await db.delete(satelliteOrbitalData).where(eq(satelliteOrbitalData.satelliteId, testSatId));
    await db.delete(satellites).where(eq(satellites.id, testSatId));
    await db.delete(groundStations).where(or(
      eq(groundStations.id, testGsId),
      eq(groundStations.id, sBandOnlyGsId)
    ));
  });

  describe("Formal Urgency & Slack-Time Metrics", () => {
    it("1. Window Slack calculation matches formal formula: Slack(T, W) = DL_T - (AOS_W + D_T)", () => {
      const now = Date.now();
      const windowAos = new Date(now + 60000); // AOS at +60s
      const durationSeconds = 300; // 5 min
      const deadline = new Date(windowAos.getTime() + durationSeconds * 1000 + 900000); // 15 min slack

      const slack = calculateWindowSlack(deadline, windowAos, durationSeconds);
      expect(slack).toBe(900); // Exactly 900 seconds
      expect(isCriticalSlack(slack, 1800)).toBe(true);
      expect(isNegativeSlack(slack)).toBe(false);
    });

    it("2. Negative Slack is identified when DL_T < AOS_W + D_T", () => {
      const now = Date.now();
      const windowAos = new Date(now + 60000);
      const durationSeconds = 300;
      // Deadline is only 100s after AOS, but task takes 300s
      const deadline = new Date(windowAos.getTime() + 100000);

      const slack = calculateWindowSlack(deadline, windowAos, durationSeconds);
      expect(slack).toBe(-200); // Negative slack of -200s
      expect(isNegativeSlack(slack)).toBe(true);
      expect(isCriticalSlack(slack)).toBe(false);
    });

    it("3. Urgency Ratio matches formal formula: UrgencyRatio(T, t_ref) = D_T / max(1, DL_T - t_ref)", () => {
      const refTime = new Date("2026-10-02T12:00:00Z");
      const deadline = new Date("2026-10-02T12:10:00Z"); // 600 seconds remaining
      const durationSeconds = 60; // 1 min duration

      const ratio = calculateUrgencyRatio(durationSeconds, deadline, refTime);
      expect(ratio).toBeCloseTo(60 / 600, 4); // 0.1

      // Past deadline gives Infinity
      const pastDeadline = new Date("2026-10-02T11:59:00Z");
      const pastRatio = calculateUrgencyRatio(durationSeconds, pastDeadline, refTime);
      expect(pastRatio).toBe(Infinity);
    });
  });

  describe("Deterministic Controlled Contention Test (Section 3 Spec Fixture)", () => {
    let w1Id: string;
    let w2Id: string;
    let taskAId: string;
    let taskBId: string;
    let baseTime: number;

    beforeAll(async () => {
      baseTime = Date.now() + 500000;

      // Window W1: duration 10 min (600s)
      const w1Aos = new Date(baseTime);
      const w1Los = new Date(baseTime + 600000);

      const [cw1] = await db.insert(contactWindows).values({
        satelliteId: testSatId,
        groundStationId: testGsId,
        orbitalDataId: testOrbitalDataId,
        aos: w1Aos,
        los: w1Los,
        durationSeconds: 600,
        maxElevationDeg: 60,
        status: "AVAILABLE",
      }).returning();
      w1Id = cw1.id;

      // Window W2: at +2 hr (7200s), duration 10 min (600s)
      const w2Aos = new Date(baseTime + 7200000);
      const w2Los = new Date(baseTime + 7800000);

      const [cw2] = await db.insert(contactWindows).values({
        satelliteId: testSatId,
        groundStationId: testGsId,
        orbitalDataId: testOrbitalDataId,
        aos: w2Aos,
        los: w2Los,
        durationSeconds: 600,
        maxElevationDeg: 45,
        status: "AVAILABLE",
      }).returning();
      w2Id = cw2.id;
    });

    afterAll(async () => {
      await db.delete(reservations).where(or(eq(reservations.contactWindowId, w1Id), eq(reservations.contactWindowId, w2Id)));
      await db.delete(contactWindows).where(or(eq(contactWindows.id, w1Id), eq(contactWindows.id, w2Id)));
    });

    it("4. Controlled Contention: Urgency policy allocates W1 to urgent Task B and W2 to Task A -> 0 misses, 0 dropped tasks", async () => {
      // Task A: High Priority (10), duration 6 min (360s), deadline +24 hr (ample slack)
      const [tA] = await db.insert(missionTasks).values({
        satelliteId: testSatId,
        name: "Task A - High Priority Ample Slack",
        priority: 10,
        durationSeconds: 360,
        deadline: new Date(baseTime + 86400000), // +24h
        status: "PENDING",
      }).returning();
      taskAId = tA.id;

      // Task B: Low Priority (2), duration 6 min (360s), deadline +15 min (900s) (critical slack, NO other window before deadline)
      const [tB] = await db.insert(missionTasks).values({
        satelliteId: testSatId,
        name: "Task B - Low Priority Critical Slack",
        priority: 2,
        durationSeconds: 360,
        deadline: new Date(baseTime + 900000), // +15 min
        status: "PENDING",
      }).returning();
      taskBId = tB.id;

      // Run UrgencyScheduler targeting these two competing tasks
      const scheduler = new UrgencyScheduler(new CandidateService(), new Date(baseTime));
      const result = await scheduler.schedulePendingTasks([taskAId, taskBId]);

      // Assertions: Both tasks scheduled!
      expect(result.scheduled).toBe(2);
      expect(result.unscheduled).toBe(0);

      // Verify that Task B got Window 1 (preventing deadline miss)
      const resvB = await db.select().from(reservations).where(eq(reservations.missionTaskId, taskBId));
      expect(resvB.length).toBe(1);
      expect(resvB[0].contactWindowId).toBe(w1Id);

      // Verify that Task A got Window 2
      const resvA = await db.select().from(reservations).where(eq(reservations.missionTaskId, taskAId));
      expect(resvA.length).toBe(1);
      expect(resvA[0].contactWindowId).toBe(w2Id);

      // Cleanup
      await db.delete(reservations).where(or(eq(reservations.missionTaskId, taskAId), eq(reservations.missionTaskId, taskBId)));
      await db.delete(missionTasks).where(or(eq(missionTasks.id, taskAId), eq(missionTasks.id, taskBId)));
    });

    it("5. Contrast Check: Naive PriorityScheduler starves urgent Task B, causing DEADLINE_EXCEEDED", async () => {
      // Re-insert exact same tasks
      const [tA] = await db.insert(missionTasks).values({
        satelliteId: testSatId,
        name: "Task A - High Priority",
        priority: 10,
        durationSeconds: 360,
        deadline: new Date(baseTime + 86400000), // +24h
        status: "PENDING",
      }).returning();

      const [tB] = await db.insert(missionTasks).values({
        satelliteId: testSatId,
        name: "Task B - Low Priority",
        priority: 2,
        durationSeconds: 360,
        deadline: new Date(baseTime + 900000), // +15 min
        status: "PENDING",
      }).returning();

      // Run PriorityScheduler
      const priorityScheduler = new PriorityScheduler(new CandidateService());
      const result = await priorityScheduler.schedulePendingTasks();

      const outcomeA = result.results.find((r) => r.taskId === tA.id);
      const outcomeB = result.results.find((r) => r.taskId === tB.id);

      // Naive Priority schedules Task A and drops urgent Task B!
      expect(outcomeA?.status).toBe("SCHEDULED");
      expect(outcomeB?.status).toBe("UNSCHEDULED");
      expect(["NO_FEASIBLE_WINDOW", "DEADLINE_EXCEEDED"]).toContain(outcomeB?.reason);

      // Cleanup
      await db.delete(reservations).where(or(eq(reservations.missionTaskId, tA.id), eq(reservations.missionTaskId, tB.id)));
      await db.delete(missionTasks).where(or(eq(missionTasks.id, tA.id), eq(missionTasks.id, tB.id)));
    });
  });

  describe("Hard Constraints Upstream Invariant (Feasibility First)", () => {
    it("6. Task with critical slack but INCOMPATIBLE RF band is rejected upstream; urgency NEVER overrides feasibility", async () => {
      const now = Date.now() + 100000;
      // Window is on S_BAND only station
      const [cwSband] = await db.insert(contactWindows).values({
        satelliteId: testSatId,
        groundStationId: sBandOnlyGsId, // Only supports S_BAND
        orbitalDataId: testOrbitalDataId,
        aos: new Date(now),
        los: new Date(now + 600000),
        durationSeconds: 600,
        maxElevationDeg: 50,
        status: "AVAILABLE",
      }).returning();

      // Urgent task requires X_BAND
      const [urgentXBandTask] = await db.insert(missionTasks).values({
        satelliteId: testSatId,
        name: "Urgent X-Band Task",
        priority: 10,
        durationSeconds: 120,
        deadline: new Date(now + 300000), // Very tight deadline (critical slack)
        requiredFrequencyBand: "X_BAND", // Incompatible with sBandOnlyGsId
        status: "PENDING",
      }).returning();

      // Constraint Validation directly verifies rejection
      const valResult = await constraintValidator.validate({
        taskId: urgentXBandTask.id,
        contactWindowId: cwSband.id,
        startTime: new Date(now + 10000),
        endTime: new Date(now + 130000),
      });

      expect(valResult.valid).toBe(false);
      expect(valResult.errors.some((e) => e.code === "INCOMPATIBLE_FREQUENCY_BAND")).toBe(true);

      // UrgencyScheduler also strictly rejects
      const scheduler = new UrgencyScheduler(new CandidateService(), new Date(now));
      const schedResult = await scheduler.schedulePendingTasks([urgentXBandTask.id]);

      expect(schedResult.scheduled).toBe(0);
      expect(schedResult.unscheduled).toBe(1);
      const outcome = schedResult.results.find((r) => r.taskId === urgentXBandTask.id);
      expect(outcome?.status).toBe("UNSCHEDULED");
      expect(outcome?.reason).toBe("INCOMPATIBLE_FREQUENCY_BAND");

      // Cleanup
      await db.delete(missionTasks).where(eq(missionTasks.id, urgentXBandTask.id));
      await db.delete(contactWindows).where(eq(contactWindows.id, cwSband.id));
    });

    it("7. Task with critical slack but INSUFFICIENT station data rate is rejected upstream", async () => {
      const now = Date.now() + 200000;
      // Station max rate is 25.0 Mbps
      const [cwRate] = await db.insert(contactWindows).values({
        satelliteId: testSatId,
        groundStationId: sBandOnlyGsId, // Max rate 25 Mbps
        orbitalDataId: testOrbitalDataId,
        aos: new Date(now),
        los: new Date(now + 600000),
        durationSeconds: 600,
        maxElevationDeg: 50,
        status: "AVAILABLE",
      }).returning();

      // Urgent task requires 100 Mbps
      const [highRateTask] = await db.insert(missionTasks).values({
        satelliteId: testSatId,
        name: "High Rate Task",
        priority: 10,
        durationSeconds: 120,
        deadline: new Date(now + 300000),
        minDataRateMbps: 100.0, // Exceeds 25 Mbps
        status: "PENDING",
      }).returning();

      const scheduler = new UrgencyScheduler(new CandidateService(), new Date(now));
      const schedResult = await scheduler.schedulePendingTasks([highRateTask.id]);

      expect(schedResult.scheduled).toBe(0);
      expect(schedResult.unscheduled).toBe(1);
      const outcome = schedResult.results.find((r) => r.taskId === highRateTask.id);
      expect(outcome?.reason).toBe("INSUFFICIENT_STATION_DATA_RATE");

      // Cleanup
      await db.delete(missionTasks).where(eq(missionTasks.id, highRateTask.id));
      await db.delete(contactWindows).where(eq(contactWindows.id, cwRate.id));
    });

    it("8. Station capacity limit (maxConcurrentContacts = 1) is strictly enforced against urgency", async () => {
      const now = Date.now() + 300000;
      const [cwCap] = await db.insert(contactWindows).values({
        satelliteId: testSatId,
        groundStationId: testGsId, // capacity = 1
        orbitalDataId: testOrbitalDataId,
        aos: new Date(now),
        los: new Date(now + 300000), // 5 min window
        durationSeconds: 300,
        maxElevationDeg: 50,
        status: "AVAILABLE",
      }).returning();

      // Occupy entire window with a manual reservation
      const [blockingTask] = await db.insert(missionTasks).values({
        satelliteId: testSatId,
        name: "Blocking Task",
        priority: 1,
        durationSeconds: 300,
        deadline: new Date(now + 3600000),
        status: "SCHEDULED",
      }).returning();

      const [blockingResv] = await db.insert(reservations).values({
        missionTaskId: blockingTask.id,
        contactWindowId: cwCap.id,
        groundStationId: testGsId,
        satelliteId: testSatId,
        windowAos: new Date(now),
        windowLos: new Date(now + 300000),
        taskDurationSeconds: 300,
        allocatedStart: new Date(now),
        allocatedEnd: new Date(now + 300000),
        status: "CONFIRMED",
        source: "MANUAL",
        locked: false,
      }).returning();

      // Urgent pending task
      const [urgentTask] = await db.insert(missionTasks).values({
        satelliteId: testSatId,
        name: "Urgent Blocked Task",
        priority: 10,
        durationSeconds: 120,
        deadline: new Date(now + 300000),
        status: "PENDING",
      }).returning();

      const scheduler = new UrgencyScheduler(new CandidateService(), new Date(now));
      const schedResult = await scheduler.schedulePendingTasks([urgentTask.id]);

      // Cannot schedule because station capacity (1) is fully occupied
      expect(schedResult.scheduled).toBe(0);
      expect(schedResult.unscheduled).toBe(1);
      const outcome = schedResult.results.find((r) => r.taskId === urgentTask.id);
      expect(outcome?.reason).toBe("NO_FEASIBLE_WINDOW");

      // Cleanup
      await db.delete(reservations).where(eq(reservations.id, blockingResv.id));
      await db.delete(missionTasks).where(or(eq(missionTasks.id, blockingTask.id), eq(missionTasks.id, urgentTask.id)));
      await db.delete(contactWindows).where(eq(contactWindows.id, cwCap.id));
    });
  });

  describe("Edge Case Error Codes (DEADLINE_EXCEEDED, NO_FEASIBLE_WINDOW, INSUFFICIENT_SLACK)", () => {
    it("9. DEADLINE_EXCEEDED and INSUFFICIENT_SLACK emitted when reservation end exceeds task deadline", async () => {
      const now = Date.now() + 400000;
      const [cw] = await db.insert(contactWindows).values({
        satelliteId: testSatId,
        groundStationId: testGsId,
        orbitalDataId: testOrbitalDataId,
        aos: new Date(now),
        los: new Date(now + 1800000),
        durationSeconds: 1800,
        maxElevationDeg: 45,
        status: "AVAILABLE",
      }).returning();

      const [task] = await db.insert(missionTasks).values({
        satelliteId: testSatId,
        name: "Late Task",
        priority: 5,
        durationSeconds: 300,
        deadline: new Date(now + 120000), // Deadline is only +120s from AOS
        status: "PENDING",
      }).returning();

      // Reservation finishes at +300s, exceeding deadline (+120s)
      const res = await request(app)
        .post("/api/reservations/preview")
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({
          taskId: task.id,
          contactWindowId: cw.id,
          startTime: new Date(now).toISOString(),
          endTime: new Date(now + 300000).toISOString(),
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      const codes = res.body.errors.map((e: any) => e.code);
      expect(codes).toContain("DEADLINE_MISSED");
      expect(codes).toContain("DEADLINE_EXCEEDED");
      expect(codes).toContain("INSUFFICIENT_SLACK");

      // Cleanup
      await db.delete(missionTasks).where(eq(missionTasks.id, task.id));
      await db.delete(contactWindows).where(eq(contactWindows.id, cw.id));
    });

    it("10. NO_FEASIBLE_WINDOW emitted when satellite has zero contact windows in database", async () => {
      // Create isolated satellite with no contact windows
      const [lonelySat] = await db.insert(satellites).values({
        noradId: 48000 + (Date.now() % 10000),
        name: "NoWindowSat",
        type: "LEO",
        status: "ACTIVE",
      }).returning();

      const [taskNoWin] = await db.insert(missionTasks).values({
        satelliteId: lonelySat.id,
        name: "No Window Task",
        priority: 5,
        durationSeconds: 120,
        deadline: new Date(Date.now() + 3600000),
        status: "PENDING",
      }).returning();

      const scheduler = new UrgencyScheduler(new CandidateService());
      const schedResult = await scheduler.schedulePendingTasks([taskNoWin.id]);

      const outcome = schedResult.results.find((r) => r.taskId === taskNoWin.id);
      expect(outcome?.status).toBe("UNSCHEDULED");
      expect(outcome?.reason).toBe("NO_FEASIBLE_WINDOW");

      // Cleanup
      await db.delete(missionTasks).where(eq(missionTasks.id, taskNoWin.id));
      await db.delete(satellites).where(eq(satellites.id, lonelySat.id));
    });

    it("11. Negative Slack candidate windows are rejected before scoring", () => {
      const now = Date.now();
      const task = {
        satelliteId: testSatId,
        deadline: new Date(now + 100000),
        durationSeconds: 300, // 300s duration
      };

      const window = {
        satelliteId: testSatId,
        groundStationId: testGsId,
        aos: new Date(now), // earliest end is now + 300s > deadline now + 100s
        los: new Date(now + 600000),
      };

      const result = constraintValidator.validateCandidateWindow(task, window);
      expect(result.valid).toBe(false);
      expect(result.slackSeconds).toBeLessThan(0); // Negative slack!
      expect(result.errors.some((e) => e.code === "INSUFFICIENT_SLACK")).toBe(true);
      expect(result.errors.some((e) => e.code === "DEADLINE_EXCEEDED")).toBe(true);
    });
  });

  describe("Equal Urgency Deterministic Tie-Breaking", () => {
    it("12. Tasks with equal urgency break ties deterministically by: priority DESC -> createdAt ASC -> id ASC", () => {
      const now = Date.now();
      const t1 = { id: "00000000-0000-0000-0000-000000000001", priority: 8, createdAt: new Date(now) };
      const t2 = { id: "00000000-0000-0000-0000-000000000002", priority: 5, createdAt: new Date(now) };

      // Higher priority comes first
      expect(compareUrgencyTieBreaker(t1, t2)).toBeLessThan(0);
      expect(compareUrgencyTieBreaker(t2, t1)).toBeGreaterThan(0);

      // Same priority -> older createdAt comes first
      const t3 = { id: "00000000-0000-0000-0000-000000000003", priority: 5, createdAt: new Date(now - 10000) };
      expect(compareUrgencyTieBreaker(t3, t2)).toBeLessThan(0);

      // Same priority and same createdAt -> lexicographical ID ASC
      const t4 = { id: "aaaaaaaa-0000-0000-0000-000000000000", priority: 5, createdAt: new Date(now) };
      const t5 = { id: "bbbbbbbb-0000-0000-0000-000000000000", priority: 5, createdAt: new Date(now) };
      expect(compareUrgencyTieBreaker(t4, t5)).toBeLessThan(0);
    });

    it("13. Scheduler schedules higher priority task when two tasks have equal slack on single slot", async () => {
      const now = Date.now() + 600000;
      const [singleWin] = await db.insert(contactWindows).values({
        satelliteId: testSatId,
        groundStationId: testGsId,
        orbitalDataId: testOrbitalDataId,
        aos: new Date(now),
        los: new Date(now + 300000), // 300s window
        durationSeconds: 300,
        maxElevationDeg: 45,
        status: "AVAILABLE",
      }).returning();

      // Task 1: Priority 9, exactly same duration & deadline
      const [taskHigh] = await db.insert(missionTasks).values({
        satelliteId: testSatId,
        name: "Tie High Priority",
        priority: 9,
        durationSeconds: 300,
        deadline: new Date(now + 600000),
        status: "PENDING",
        createdAt: new Date(now),
      }).returning();

      // Task 2: Priority 4, exactly same duration & deadline
      const [taskLow] = await db.insert(missionTasks).values({
        satelliteId: testSatId,
        name: "Tie Low Priority",
        priority: 4,
        durationSeconds: 300,
        deadline: new Date(now + 600000),
        status: "PENDING",
        createdAt: new Date(now),
      }).returning();

      const scheduler = new UrgencyScheduler(new CandidateService(), new Date(now));
      const res = await scheduler.schedulePendingTasks([taskHigh.id, taskLow.id]);

      // Exactly 1 can fit
      expect(res.scheduled).toBe(1);
      expect(res.unscheduled).toBe(1);

      // Higher priority wins the tie
      const highOutcome = res.results.find((r) => r.taskId === taskHigh.id);
      const lowOutcome = res.results.find((r) => r.taskId === taskLow.id);

      expect(highOutcome?.status).toBe("SCHEDULED");
      expect(lowOutcome?.status).toBe("UNSCHEDULED");
      expect(lowOutcome?.reason).toBe("NO_FEASIBLE_WINDOW");

      // Cleanup
      await db.delete(reservations).where(eq(reservations.missionTaskId, taskHigh.id));
      await db.delete(missionTasks).where(or(eq(missionTasks.id, taskHigh.id), eq(missionTasks.id, taskLow.id)));
      await db.delete(contactWindows).where(eq(contactWindows.id, singleWin.id));
    });
  });

  describe("MANUAL + LOCKED Invariance", () => {
    it("14. MANUAL + LOCKED reservation is an immutable barrier and survives automated urgency scheduling", async () => {
      const now = Date.now() + 700000;
      const [lockedWin] = await db.insert(contactWindows).values({
        satelliteId: testSatId,
        groundStationId: testGsId,
        orbitalDataId: testOrbitalDataId,
        aos: new Date(now),
        los: new Date(now + 600000),
        durationSeconds: 600,
        maxElevationDeg: 45,
        status: "AVAILABLE",
      }).returning();

      const [lockedTask] = await db.insert(missionTasks).values({
        satelliteId: testSatId,
        name: "Manual Locked Task",
        priority: 1,
        durationSeconds: 600,
        deadline: new Date(now + 3600000),
        status: "SCHEDULED",
      }).returning();

      // Insert MANUAL + LOCKED reservation occupying entire window
      const [lockedResv] = await db.insert(reservations).values({
        missionTaskId: lockedTask.id,
        contactWindowId: lockedWin.id,
        groundStationId: testGsId,
        satelliteId: testSatId,
        windowAos: new Date(now),
        windowLos: new Date(now + 600000),
        taskDurationSeconds: 600,
        allocatedStart: new Date(now),
        allocatedEnd: new Date(now + 600000),
        status: "CONFIRMED",
        source: "MANUAL",
        locked: true,
      }).returning();

      // Pending urgent task
      const [urgentTask] = await db.insert(missionTasks).values({
        satelliteId: testSatId,
        name: "Urgent Task Clashing With Locked",
        priority: 10,
        durationSeconds: 300,
        deadline: new Date(now + 600000),
        status: "PENDING",
      }).returning();

      const scheduler = new UrgencyScheduler(new CandidateService(), new Date(now));
      const res = await scheduler.schedulePendingTasks([urgentTask.id]);

      // Urgent task cannot clobber locked reservation
      expect(res.scheduled).toBe(0);
      expect(res.unscheduled).toBe(1);

      // Verify locked reservation is completely untouched in database
      const existingLocked = await db.select().from(reservations).where(eq(reservations.id, lockedResv.id));
      expect(existingLocked.length).toBe(1);
      expect(existingLocked[0].locked).toBe(true);
      expect(existingLocked[0].source).toBe("MANUAL");

      // Cleanup
      await db.delete(reservations).where(eq(reservations.id, lockedResv.id));
      await db.delete(missionTasks).where(or(eq(missionTasks.id, lockedTask.id), eq(missionTasks.id, urgentTask.id)));
      await db.delete(contactWindows).where(eq(contactWindows.id, lockedWin.id));
    });
  });

  describe("API Integration & Preview Non-Mutation with Urgency Policy", () => {
    it("15. POST /api/scheduler/urgency/run schedules pending tasks via authenticated API", async () => {
      const now = Date.now() + 800000;
      const [win] = await db.insert(contactWindows).values({
        satelliteId: testSatId,
        groundStationId: testGsId,
        orbitalDataId: testOrbitalDataId,
        aos: new Date(now),
        los: new Date(now + 600000),
        durationSeconds: 600,
        maxElevationDeg: 45,
        status: "AVAILABLE",
      }).returning();

      const [task] = await db.insert(missionTasks).values({
        satelliteId: testSatId,
        name: "API Urgency Task",
        priority: 7,
        durationSeconds: 180,
        deadline: new Date(now + 900000),
        status: "PENDING",
      }).returning();

      const res = await request(app)
        .post("/api/scheduler/urgency/run")
        .set("Authorization", `Bearer ${operatorToken}`);

      expect(res.status).toBe(200);
      expect(res.body.scheduled).toBeGreaterThanOrEqual(1);

      // Cleanup
      await db.delete(reservations).where(or(
        eq(reservations.missionTaskId, task.id),
        eq(reservations.contactWindowId, win.id)
      ));
      await db.delete(missionTasks).where(eq(missionTasks.id, task.id));
      await db.delete(contactWindows).where(eq(contactWindows.id, win.id));
    });

    it("16. POST /api/scheduler/preview with policy='URGENCY' produces zero DB mutations", async () => {
      const [currentVerRow] = await db.select().from(scheduleVersions).limit(1);
      const currentVersion = currentVerRow?.version ?? 0;

      const countBefore = await db.select({ count: sql<number>`count(*)` }).from(reservations);

      const res = await request(app)
        .post("/api/scheduler/preview")
        .set("Authorization", `Bearer ${operatorToken}`)
        .send({
          scheduleVersion: currentVersion,
          policy: "URGENCY",
        });

      expect(res.status).toBe(200);
      expect(res.body.scheduleVersion).toBe(currentVersion);
      expect(res.body.proposedReservations).toBeDefined();

      const countAfter = await db.select({ count: sql<number>`count(*)` }).from(reservations);
      expect(countBefore[0].count).toBe(countAfter[0].count); // Zero DB mutation
    });
  });
});
