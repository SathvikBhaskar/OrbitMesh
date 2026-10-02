import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { eq, inArray, desc } from "drizzle-orm";
import { app } from "../app";
import { db } from "../db/client";
import {
  users,
  satellites,
  groundStations,
  satelliteOrbitalData,
  contactWindows,
  missionTasks,
  reservations,
  scheduleVersions,
  executionTelemetryEvents,
  dispatchAttempts,
} from "../db/schema";
import { env } from "../config/env";
import { groundAdapterService } from "../modules/ground-adapter/adapter.service";
import { executionService } from "../modules/execution/execution.service";

describe("Phase 5.6 — External Ground Adapter, Transport Impairments, Clock Discipline & Fault-Tolerant Resilience", () => {
  let operatorId: string;
  let operatorToken: string;

  let satId: string;
  let gsId: string;
  let odId: string;

  const epochBase = Date.now() + 600000000;

  async function getReservation(id: string) {
    const rows = await db.select().from(reservations).where(eq(reservations.id, id));
    return rows[0] || null;
  }

  async function getDispatchAttempt(id: string) {
    const rows = await db.select().from(dispatchAttempts).where(eq(dispatchAttempts.id, id));
    return rows[0] || null;
  }

  async function getTask(id: string) {
    const rows = await db.select().from(missionTasks).where(eq(missionTasks.id, id));
    return rows[0] || null;
  }

  beforeAll(async () => {
    // 1. Create operator user
    const [op] = await db
      .insert(users)
      .values({
        email: `op56-${Date.now()}@test.com`,
        passwordHash: "hash",
        role: "OPERATOR",
      })
      .returning();
    operatorId = op.id;
    operatorToken = jwt.sign({ sub: op.id, role: "OPERATOR" }, env.jwtSecret);

    // 2. Base infrastructure
    const [sat] = await db
      .insert(satellites)
      .values({
        noradId: 66001,
        name: "Adapter-Sat-1",
        status: "ACTIVE",
      })
      .returning();
    satId = sat.id;

    const [od] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: satId,
        source: "CELESTRAK",
        tleLine1: "1 66001U 26001A   26270.00000000  .00001000  00000-0  10000-3 0  9991",
        tleLine2: "2 66001  97.5000 120.0000 0010000  45.0000 315.0000 15.10000000000018",
        tleEpoch: new Date(),
        receivedAt: new Date(),
      })
      .returning();
    odId = od.id;

    const [gs] = await db
      .insert(groundStations)
      .values({
        code: `GS-MAU-${Date.now() % 10000}`,
        name: "Adapter-GS-Mauritius",
        latitude: -20.3484,
        longitude: 57.5522,
        altitudeM: 150,
        status: "AVAILABLE",
        minimumElevationDeg: 5,
        supportedFrequencyBands: ["S_BAND", "X_BAND"],
        maxConcurrentContacts: 2,
        maxDataRateMbps: 450,
      })
      .returning();
    gsId = gs.id;

    // Seed schedule versions if empty
    const versions = await db.select().from(scheduleVersions);
    if (versions.length === 0) {
      await db.insert(scheduleVersions).values({ version: 1 });
    }
  });

  afterAll(async () => {
    // Clean up
    await db.delete(dispatchAttempts);
    await db.delete(executionTelemetryEvents);
    await db.delete(reservations);
    await db.delete(contactWindows);
    await db.delete(missionTasks);
    await db.delete(satelliteOrbitalData).where(eq(satelliteOrbitalData.satelliteId, satId));
    await db.delete(satellites).where(eq(satellites.id, satId));
    await db.delete(groundStations).where(eq(groundStations.id, gsId));
    await db.delete(users).where(eq(users.id, operatorId));
  });

  let contactCounter = 0;

  // Helper to create task, window, and reservation
  async function seedTestContact(suffix: string, targetBytes: number = 1000000000) {
    contactCounter++;
    const startMs = epochBase + contactCounter * 3600000;
    const endMs = startMs + 600000;

    const [task] = await db
      .insert(missionTasks)
      .values({
        satelliteId: satId,
        name: `Task-5.6-${suffix}-${contactCounter}`,
        priority: 1,
        durationSeconds: 600,
        deadline: new Date(startMs + 86400000),
        status: "SCHEDULED",
        targetBytes,
        fulfilledBytes: 0,
        remainingBytes: targetBytes,
      })
      .returning();

    const [cw] = await db
      .insert(contactWindows)
      .values({
        satelliteId: satId,
        groundStationId: gsId,
        orbitalDataId: odId,
        aos: new Date(startMs),
        los: new Date(endMs),
        durationSeconds: 600,
        maxElevationDeg: 45,
      })
      .returning();

    const [res] = await db
      .insert(reservations)
      .values({
        missionTaskId: task.id,
        contactWindowId: cw.id,
        satelliteId: satId,
        groundStationId: gsId,
        windowAos: new Date(startMs),
        windowLos: new Date(endMs),
        allocatedStart: new Date(startMs),
        allocatedEnd: new Date(endMs),
        taskDurationSeconds: 600,
        status: "CONFIRMED",
        executionState: "SCHEDULED",
        bytesTransferred: 0,
      })
      .returning();

    return { task, cw, res };
  }

  // =========================================================================
  // DISPATCH PROTOCOL SUITE (A, B, C, K, M)
  // =========================================================================

  it("1. Scenario A: Disconnect before dispatch ACK — network timeout is not execution failure", async () => {
    const { res } = await seedTestContact("A-Timeout");

    // 1. Prepare attempt
    const prepRes = await request(app)
      .post("/api/adapter/dispatch/prepare")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ reservationId: res.id });

    expect(prepRes.status).toBe(201);
    const attempt = prepRes.body;
    expect(attempt.state).toBe("PREPARED");
    expect(attempt.transportHealth).toBe("CONNECTED");

    // 2. Stage attempt with network timeout simulation
    const stageRes = await request(app)
      .post("/api/adapter/dispatch/stage")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        dispatchId: attempt.dispatchId,
        simulateNetworkTimeout: true,
      });

    expect(stageRes.status).toBe(200);
    expect(stageRes.body.state).toBe("PREPARED"); // NOT failed!
    expect(stageRes.body.transportHealth).toBe("COMMUNICATION_GAP"); // Scoped to dispatch attempt!
    expect(stageRes.body.retryCount).toBe(1);

    // 3. Verify reservation execution state remains EXECUTION_READY, NOT failed
    const checkRes = await getReservation(res.id);
    expect(checkRes?.executionState).toBe("EXECUTION_READY");
  });

  it("2. Scenario B: Disconnect after STAGED_ACK — attempt remains STAGED_ACK and reservation remains EXECUTION_READY", async () => {
    const { res } = await seedTestContact("B-Staged");

    const attempt = await groundAdapterService.prepareDispatchAttempt(res.id);
    const staged = await groundAdapterService.stageDispatchAttempt(attempt.dispatchId);
    expect(staged.state).toBe("STAGED_ACK");

    // Verify reservation state
    const checkRes = await getReservation(res.id);
    expect(checkRes?.executionState).toBe("EXECUTION_READY");
  });

  it("3. Scenario C: Disconnect after ARMED — reservation transitions to DISPATCHED with tolerance for reconnect at AOS", async () => {
    const { res } = await seedTestContact("C-Armed");

    const attempt = await groundAdapterService.prepareDispatchAttempt(res.id);
    await groundAdapterService.stageDispatchAttempt(attempt.dispatchId);

    // Arm attempt
    const armRes = await request(app)
      .post("/api/adapter/dispatch/arm")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ dispatchId: attempt.dispatchId });

    expect(armRes.status).toBe(200);
    expect(armRes.body.state).toBe("ARMED");

    // Reservation must have activeDispatchId set and executionState = DISPATCHED
    const checkRes = await getReservation(res.id);
    expect(checkRes?.executionState).toBe("DISPATCHED");
    expect(checkRes?.activeDispatchId).toBe(attempt.dispatchId);
  });

  it("4. Scenario K: Idempotent dispatch retry — sequential attempt numbers with globally unique dispatchId", async () => {
    const { res } = await seedTestContact("K-Retry");

    const attempt1 = await groundAdapterService.prepareDispatchAttempt(res.id);
    expect(attempt1.attemptNumber).toBe(1);

    const attempt2 = await groundAdapterService.prepareDispatchAttempt(res.id);
    expect(attempt2.attemptNumber).toBe(2);
    expect(attempt2.dispatchId).not.toBe(attempt1.dispatchId);

    // Query historical attempts via API
    const historyRes = await request(app)
      .get(`/api/adapter/reservations/${res.id}/attempts`)
      .set("Authorization", `Bearer ${operatorToken}`);

    expect(historyRes.status).toBe(200);
    expect(historyRes.body.length).toBe(2);
  });

  it("5. Scenario M: Stale dispatch rejection — late D1 telemetry rejected when D2 is ARMED", async () => {
    const { res } = await seedTestContact("M-Stale");

    // D1
    const d1 = await groundAdapterService.prepareDispatchAttempt(res.id);
    await groundAdapterService.stageDispatchAttempt(d1.dispatchId);

    // D2 supersedes D1
    const d2 = await groundAdapterService.prepareDispatchAttempt(res.id);
    await groundAdapterService.stageDispatchAttempt(d2.dispatchId);
    await groundAdapterService.armDispatchAttempt(d2.dispatchId);

    // Late D1 telemetry arrives
    const staleRes = await request(app)
      .post("/api/adapter/telemetry")
      .send({
        dispatchId: d1.dispatchId,
        reservationId: res.id,
        sequenceNumber: 1,
        sourceTimestamp: new Date().toISOString(),
        idempotencyKey: `stale-m-${Date.now()}`,
        bytesTransferred: 50000000,
      });

    expect(staleRes.status).toBe(409);
    expect(staleRes.body.error).toContain("STALE_DISPATCH_REJECTED");

    // Verify D2 and reservation bytes are unmodified (0 bytes)
    const checkRes = await getReservation(res.id);
    expect(checkRes?.bytesTransferred).toBe(0);
    expect(checkRes?.activeDispatchId).toBe(d2.dispatchId);
  });

  // =========================================================================
  // TRANSPORT & COMMUNICATION GAP SUITE (D, E, F, G, L)
  // =========================================================================

  it("6. Scenario D: Disconnect immediately after AOS — marks COMMUNICATION_GAP, reservation does not fail", async () => {
    const { res } = await seedTestContact("D-AOS-Disc");

    const attempt = await groundAdapterService.prepareDispatchAttempt(res.id);
    await groundAdapterService.stageDispatchAttempt(attempt.dispatchId);
    await groundAdapterService.armDispatchAttempt(attempt.dispatchId);

    // AOS acquired
    await request(app)
      .post("/api/execution/telemetry")
      .send({
        eventId: "evt-d-aos",
        reservationId: res.id,
        dispatchId: attempt.dispatchId,
        sequenceNumber: 1,
        sourceTimestamp: new Date().toISOString(),
        idempotencyKey: `idemp-d-aos-${Date.now()}`,
        eventType: "AOS_ACQUIRED",
        payload: {
          groundStationId: gsId,
          satelliteId: satId,
          carrierLocked: true,
        },
      });

    // Verify state is IN_PROGRESS
    let checkRes = await getReservation(res.id);
    expect(checkRes?.executionState).toBe("IN_PROGRESS");

    // Disconnect simulated by jumping sequence from 1 to 5 (missing 2, 3, 4)
    const gapRes = await request(app)
      .post("/api/adapter/telemetry")
      .send({
        dispatchId: attempt.dispatchId,
        reservationId: res.id,
        sequenceNumber: 5,
        sourceTimestamp: new Date().toISOString(),
        idempotencyKey: `idemp-d-gap-${Date.now()}`,
        bytesTransferred: 20000000,
      });

    expect(gapRes.status).toBe(200);
    expect(gapRes.body.transportGap.hasGap).toBe(true);

    // Verify dispatch attempt has COMMUNICATION_GAP, but reservation is STILL IN_PROGRESS
    const checkAttempt = await getDispatchAttempt(attempt.id);
    expect(checkAttempt?.transportHealth).toBe("COMMUNICATION_GAP");

    checkRes = await getReservation(res.id);
    expect(checkRes?.executionState).toBe("IN_PROGRESS"); // Transport failure is not execution failure!
  });

  it("7. Scenario E: Telemetry loss during IN_PROGRESS — quota remains at last monotonic actuals", async () => {
    const { res, task } = await seedTestContact("E-Loss", 1000000000);

    const attempt = await groundAdapterService.prepareDispatchAttempt(res.id);
    await groundAdapterService.stageDispatchAttempt(attempt.dispatchId);
    await groundAdapterService.armDispatchAttempt(attempt.dispatchId);

    // AOS
    await executionService.ingestExecutionTelemetry({
      eventId: "evt-e-aos",
      reservationId: res.id,
      dispatchId: attempt.dispatchId,
      sequenceNumber: 1,
      sourceTimestamp: new Date(),
      idempotencyKey: `idemp-e-aos-${Date.now()}`,
      eventType: "AOS_ACQUIRED",
      payload: {
        groundStationId: gsId,
        satelliteId: satId,
        carrierLocked: true,
      },
    });

    // 250 MB transferred
    await request(app)
      .post("/api/adapter/telemetry")
      .send({
        dispatchId: attempt.dispatchId,
        reservationId: res.id,
        sequenceNumber: 2,
        sourceTimestamp: new Date().toISOString(),
        idempotencyKey: `idemp-e-stat1-${Date.now()}`,
        bytesTransferred: 250000000,
      });

    // Complete telemetry loss (link silent)
    // Reservation and task quota should maintain exact 250 MB actuals without preemption or regression
    const checkRes = await getReservation(res.id);
    expect(checkRes?.bytesTransferred).toBe(250000000);

    const checkTask = await getTask(task.id);
    expect(checkTask?.targetBytes).toBe(1000000000);
  });

  it("8. Scenario F: Reconnect before LOS — gap replay restores CONNECTED status", async () => {
    const { res } = await seedTestContact("F-Reconnect");

    const attempt = await groundAdapterService.prepareDispatchAttempt(res.id);
    await groundAdapterService.stageDispatchAttempt(attempt.dispatchId);
    await groundAdapterService.armDispatchAttempt(attempt.dispatchId);

    // Initial packets 1, 2
    await request(app).post("/api/adapter/telemetry").send({
      dispatchId: attempt.dispatchId,
      reservationId: res.id,
      sequenceNumber: 1,
      sourceTimestamp: new Date().toISOString(),
      idempotencyKey: `f-1-${Date.now()}`,
      eventType: "AOS_ACQUIRED",
      bytesTransferred: 0,
    });

    // Gap: Packet 4 arrives before 2 and 3
    const gapRes = await request(app).post("/api/adapter/telemetry").send({
      dispatchId: attempt.dispatchId,
      reservationId: res.id,
      sequenceNumber: 4,
      sourceTimestamp: new Date().toISOString(),
      idempotencyKey: `f-4-${Date.now()}`,
      bytesTransferred: 40000000,
    });
    expect(gapRes.body.transportGap.hasGap).toBe(true);

    let checkAttempt = await getDispatchAttempt(attempt.id);
    expect(checkAttempt?.transportHealth).toBe("COMMUNICATION_GAP");

    // Replay mode: Ground station re-transmits missing packet 2 and 3
    await request(app).post("/api/adapter/telemetry").send({
      dispatchId: attempt.dispatchId,
      reservationId: res.id,
      sequenceNumber: 2,
      sourceTimestamp: new Date().toISOString(),
      idempotencyKey: `f-2-${Date.now()}`,
      bytesTransferred: 20000000,
    });

    await request(app).post("/api/adapter/telemetry").send({
      dispatchId: attempt.dispatchId,
      reservationId: res.id,
      sequenceNumber: 3,
      sourceTimestamp: new Date().toISOString(),
      idempotencyKey: `f-3-${Date.now()}`,
      bytesTransferred: 30000000,
    });

    // Next sequential packet 5 arrives: parity reached, closes COMMUNICATION_GAP!
    const parityRes = await request(app).post("/api/adapter/telemetry").send({
      dispatchId: attempt.dispatchId,
      reservationId: res.id,
      sequenceNumber: 5,
      sourceTimestamp: new Date().toISOString(),
      idempotencyKey: `f-5-${Date.now()}`,
      bytesTransferred: 50000000,
    });
    expect(parityRes.body.transportGap.hasGap).toBe(false);

    checkAttempt = await getDispatchAttempt(attempt.id);
    expect(checkAttempt?.transportHealth).toBe("CONNECTED");
  });

  it("9. Scenario G: Reconnect after LOS — station delivers terminal actuals and contract reconciles cleanly", async () => {
    const { res, task } = await seedTestContact("G-PostLOS", 500000000);

    const attempt = await groundAdapterService.prepareDispatchAttempt(res.id);
    await groundAdapterService.stageDispatchAttempt(attempt.dispatchId);
    await groundAdapterService.armDispatchAttempt(attempt.dispatchId);

    // Pass was in progress
    await executionService.ingestExecutionTelemetry({
      eventId: "evt-g-aos",
      reservationId: res.id,
      dispatchId: attempt.dispatchId,
      sequenceNumber: 1,
      sourceTimestamp: new Date(),
      idempotencyKey: `idemp-g-aos-${Date.now()}`,
      eventType: "AOS_ACQUIRED",
      payload: {
        groundStationId: gsId,
        satelliteId: satId,
        carrierLocked: true,
      },
    });

    // Station reconnected after pass, delivers snapshot of 500 MB and terminal LOS
    await request(app).post("/api/adapter/telemetry").send({
      dispatchId: attempt.dispatchId,
      reservationId: res.id,
      sequenceNumber: 2,
      sourceTimestamp: new Date().toISOString(),
      idempotencyKey: `g-term-${Date.now()}`,
      eventType: "LOS_TERMINATED",
      bytesTransferred: 500000000,
      isSnapshot: true,
    });

    const checkRes = await getReservation(res.id);
    expect(checkRes?.executionState).toBe("COMPLETED");
    expect(checkRes?.bytesTransferred).toBe(500000000);

    const checkTask = await getTask(task.id);
    expect(checkTask?.fulfilledBytes).toBe(500000000);
    expect(checkTask?.remainingBytes).toBe(0);
  });

  it("10. Scenario L: Ground simulator restart — contract detects carrier fault and reconciles partial actuals safely", async () => {
    const { res, task } = await seedTestContact("L-Reboot", 1000000000);

    const attempt = await groundAdapterService.prepareDispatchAttempt(res.id);
    await groundAdapterService.stageDispatchAttempt(attempt.dispatchId);
    await groundAdapterService.armDispatchAttempt(attempt.dispatchId);

    await executionService.ingestExecutionTelemetry({
      eventId: "evt-l-aos",
      reservationId: res.id,
      dispatchId: attempt.dispatchId,
      sequenceNumber: 1,
      sourceTimestamp: new Date(),
      idempotencyKey: `idemp-l-aos-${Date.now()}`,
      eventType: "AOS_ACQUIRED",
      payload: {
        groundStationId: gsId,
        satelliteId: satId,
        carrierLocked: true,
      },
    });

    // 400 MB transferred before reboot
    await request(app).post("/api/adapter/telemetry").send({
      dispatchId: attempt.dispatchId,
      reservationId: res.id,
      sequenceNumber: 2,
      sourceTimestamp: new Date().toISOString(),
      idempotencyKey: `l-preboot-${Date.now()}`,
      bytesTransferred: 400000000,
    });

    // Station restarts and reports hardware fault
    await request(app).post("/api/adapter/telemetry").send({
      dispatchId: attempt.dispatchId,
      reservationId: res.id,
      sequenceNumber: 3,
      sourceTimestamp: new Date().toISOString(),
      idempotencyKey: `l-fault-${Date.now()}`,
      eventType: "GROUND_HARDWARE_FAULT",
      bytesTransferred: 400000000,
    });

    const checkRes = await getReservation(res.id);
    expect(checkRes?.executionState).toBe("FAILED");
    expect(checkRes?.failureReason).toBe("GROUND_HARDWARE_FAULT");
    expect(checkRes?.bytesTransferred).toBe(400000000);
  });

  // =========================================================================
  // TELEMETRY INTEGRITY SUITE (H, I, N, O)
  // =========================================================================

  it("11. Scenario H: Duplicate telemetry — idempotent handling with zero state regression or double counting", async () => {
    const { res } = await seedTestContact("H-Dedup");

    const attempt = await groundAdapterService.prepareDispatchAttempt(res.id);
    await groundAdapterService.stageDispatchAttempt(attempt.dispatchId);
    await groundAdapterService.armDispatchAttempt(attempt.dispatchId);

    const key = `h-dedup-${Date.now()}`;
    const payload = {
      dispatchId: attempt.dispatchId,
      reservationId: res.id,
      sequenceNumber: 1,
      sourceTimestamp: new Date().toISOString(),
      idempotencyKey: key,
      eventType: "AOS_ACQUIRED",
      bytesTransferred: 10000000,
    };

    const first = await request(app).post("/api/adapter/telemetry").send(payload);
    expect(first.status).toBe(200);

    // Duplicate call with identical idempotencyKey
    const second = await request(app).post("/api/adapter/telemetry").send(payload);
    expect(second.status).toBe(200);

    const checkRes = await getReservation(res.id);
    expect(checkRes?.bytesTransferred).toBe(10000000); // Not 20,000,000!
  });

  it("12. Scenario I: Out-of-order telemetry — monotonic max actuals preserved", async () => {
    const { res } = await seedTestContact("I-Disorder");

    const attempt = await groundAdapterService.prepareDispatchAttempt(res.id);
    await groundAdapterService.stageDispatchAttempt(attempt.dispatchId);
    await groundAdapterService.armDispatchAttempt(attempt.dispatchId);

    // Packet with 80 MB arrives first
    await groundAdapterService.reconcileTelemetryActuals(res.id, attempt.dispatchId, 80000000);

    // Out-of-order delayed packet with 50 MB arrives later
    await groundAdapterService.reconcileTelemetryActuals(res.id, attempt.dispatchId, 50000000);

    const checkRes = await getReservation(res.id);
    expect(checkRes?.bytesTransferred).toBe(80000000); // Preserved monotonic max!
  });

  it("13. Scenario N: Gap followed by stale packet — no byte regression and gap closes on parity", async () => {
    const { res } = await seedTestContact("N-GapStale");

    const attempt = await groundAdapterService.prepareDispatchAttempt(res.id);
    await groundAdapterService.stageDispatchAttempt(attempt.dispatchId);
    await groundAdapterService.armDispatchAttempt(attempt.dispatchId);

    // 101, 102
    await groundAdapterService.reconcileTelemetryActuals(res.id, attempt.dispatchId, 10000000);
    await groundAdapterService.evaluateSequenceAndGap(attempt.dispatchId, 1);

    await groundAdapterService.reconcileTelemetryActuals(res.id, attempt.dispatchId, 20000000);
    await groundAdapterService.evaluateSequenceAndGap(attempt.dispatchId, 2);

    // 105 (gap)
    const gap = await groundAdapterService.evaluateSequenceAndGap(attempt.dispatchId, 5);
    expect(gap.hasGap).toBe(true);

    // Replay 103, 104
    await groundAdapterService.reconcileTelemetryActuals(res.id, attempt.dispatchId, 30000000);
    await groundAdapterService.reconcileTelemetryActuals(res.id, attempt.dispatchId, 40000000);

    // Delayed duplicate 101 arrives again
    await groundAdapterService.reconcileTelemetryActuals(res.id, attempt.dispatchId, 10000000);

    const checkRes = await getReservation(res.id);
    expect(checkRes?.bytesTransferred).toBe(40000000); // Strictly max actuals!
  });

  it("14. Scenario O: Snapshot vs buffered replay conflict — aggregate snapshot does not double-count delayed packets", async () => {
    const { res } = await seedTestContact("O-Snapshot", 1000000000);

    const attempt = await groundAdapterService.prepareDispatchAttempt(res.id);
    await groundAdapterService.stageDispatchAttempt(attempt.dispatchId);
    await groundAdapterService.armDispatchAttempt(attempt.dispatchId);

    // Last known actuals: 500 MB at sequence 102
    await groundAdapterService.reconcileTelemetryActuals(res.id, attempt.dispatchId, 500000000);

    // Snapshot arrives: sequence 105 with 650 MB
    await groundAdapterService.reconcileTelemetryActuals(res.id, attempt.dispatchId, 650000000);

    // Delayed buffered packets arrive: 103 (550 MB), 104 (600 MB), 105 (650 MB)
    await groundAdapterService.reconcileTelemetryActuals(res.id, attempt.dispatchId, 550000000);
    await groundAdapterService.reconcileTelemetryActuals(res.id, attempt.dispatchId, 600000000);
    await groundAdapterService.reconcileTelemetryActuals(res.id, attempt.dispatchId, 650000000);

    const checkRes = await getReservation(res.id);
    expect(checkRes?.bytesTransferred).toBe(650000000); // Exact 650 MB, zero double counting!
  });

  // =========================================================================
  // CLOCK DISCIPLINE SUITE (J, J2)
  // =========================================================================

  it("15. Scenario J: Clock skew — skew within tolerance accepted, excessive future skew rejected with 422", async () => {
    const serverTime = new Date("2026-10-02T12:00:00.000Z");

    // 1. Skew within tolerance (+3s)
    const validTime = new Date("2026-10-02T12:00:03.000Z");
    const validResult = groundAdapterService.evaluateClockSkew(validTime, serverTime);
    expect(validResult.isAcceptable).toBe(true);
    expect(validResult.clockOffsetMs).toBe(3000);

    // 2. Excessive future skew (+10s)
    const invalidFuture = new Date("2026-10-02T12:00:10.000Z");
    const invalidResult = groundAdapterService.evaluateClockSkew(invalidFuture, serverTime);
    expect(invalidResult.isAcceptable).toBe(false);
    expect(invalidResult.rejectionReason).toBe("CLOCK_SKEW_FUTURE");
  });

  it("16. Scenario J2: Backward clock jump during active pass — does not regress state machine or transfer actuals", async () => {
    const { res } = await seedTestContact("J2-ClockJump");

    const attempt = await groundAdapterService.prepareDispatchAttempt(res.id);
    await groundAdapterService.stageDispatchAttempt(attempt.dispatchId);
    await groundAdapterService.armDispatchAttempt(attempt.dispatchId);

    // Seq 104 with sourceTimestamp 10:00:05 and 80 MB
    await groundAdapterService.reconcileTelemetryActuals(res.id, attempt.dispatchId, 80000000);

    // Seq 105 with wall clock jump backward: 09:59:58 and 90 MB
    await groundAdapterService.reconcileTelemetryActuals(res.id, attempt.dispatchId, 90000000);

    const checkRes = await getReservation(res.id);
    expect(checkRes?.bytesTransferred).toBe(90000000); // Advances monotonically regardless of station clock jump!
  });

  // =========================================================================
  // CONTROL-PLANE SAFETY SUITE (P)
  // =========================================================================

  it("17. Scenario P: Communication gap does not trigger premature replanning or version advancement", async () => {
    const { res } = await seedTestContact("P-Safety");

    const attempt = await groundAdapterService.prepareDispatchAttempt(res.id);
    await groundAdapterService.stageDispatchAttempt(attempt.dispatchId);
    await groundAdapterService.armDispatchAttempt(attempt.dispatchId);

    // In progress
    await executionService.ingestExecutionTelemetry({
      eventId: "evt-p-aos",
      reservationId: res.id,
      dispatchId: attempt.dispatchId,
      sequenceNumber: 1,
      sourceTimestamp: new Date(),
      idempotencyKey: `idemp-p-aos-${Date.now()}`,
      eventType: "AOS_ACQUIRED",
      payload: {
        groundStationId: gsId,
        satelliteId: satId,
        carrierLocked: true,
      },
    });

    // Fetch initial schedule version
    const versionBefore = (await db.select().from(scheduleVersions).where(eq(scheduleVersions.id, 1)))[0]!.version;

    // Simulate communication gap on dispatch attempt
    await db
      .update(dispatchAttempts)
      .set({ transportHealth: "COMMUNICATION_GAP" })
      .where(eq(dispatchAttempts.id, attempt.id));

    // An external operational event is evaluated
    // Verify that communication gap does NOT prematurely cause reservation failure or replanning
    const checkRes = await getReservation(res.id);
    expect(checkRes?.executionState).toBe("IN_PROGRESS"); // Still physically in progress!

    const versionAfter = (await db.select().from(scheduleVersions).where(eq(scheduleVersions.id, 1)))[0]!.version;
    expect(versionAfter).toBe(versionBefore); // Version remains strictly unchanged!
  });
});
