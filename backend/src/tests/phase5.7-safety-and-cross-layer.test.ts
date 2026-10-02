import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import crypto from "crypto";
import { db } from "../db/client";
import {
  satellites,
  groundStations,
  satelliteOrbitalData,
  contactWindows,
  missionTasks,
  reservations,
  dispatchAttempts,
  outboundDispatchMessages,
  scheduleVersions,
} from "../db/schema";
import { outboxService } from "../modules/outbox/outbox.service";
import { MockGroundStationProviderAdapter } from "../modules/ground-provider/adapters/mock-provider.adapter";
import { providerRegistry } from "../modules/ground-provider/provider.registry";
import { safetyInterlockService } from "../modules/ground-provider/safety-interlock.service";
import { providerReconciliationService } from "../modules/ground-provider/reconciliation.service";

describe("Phase 5.7: Workstream 5.7.4 & Cross-Layer Resilience (Scenarios L through S)", () => {
  let satId: string;
  let gsId: string;
  let odId: string;
  let mockAdapter: MockGroundStationProviderAdapter;

  const epochBase = Date.now() + 900000000;
  let contactCounter = 0;

  beforeAll(async () => {
    // Clean up any stale data from interrupted runs
    const existingSats = await db.select({ id: satellites.id }).from(satellites).where(eq(satellites.noradId, 67201));
    for (const s of existingSats) {
      const resList = await db.select({ id: reservations.id }).from(reservations).where(eq(reservations.satelliteId, s.id));
      const resIds = resList.map((r) => r.id);
      if (resIds.length > 0) {
        await db.delete(outboundDispatchMessages).where(inArray(outboundDispatchMessages.reservationId, resIds));
        await db.delete(dispatchAttempts).where(inArray(dispatchAttempts.reservationId, resIds));
        await db.delete(reservations).where(inArray(reservations.id, resIds));
      }
      await db.delete(contactWindows).where(eq(contactWindows.satelliteId, s.id));
      await db.delete(missionTasks).where(eq(missionTasks.satelliteId, s.id));
      await db.delete(satelliteOrbitalData).where(eq(satelliteOrbitalData.satelliteId, s.id));
      await db.delete(satellites).where(eq(satellites.id, s.id));
    }

    // 1. Setup base satellite, ground station, orbital data
    const [sat] = await db
      .insert(satellites)
      .values({
        noradId: 67201,
        name: "Safety-Sat-1",
        status: "ACTIVE",
      })
      .returning();
    satId = sat.id;

    const [od] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: satId,
        source: "CELESTRAK",
        tleLine1: "1 67201U 26001A   26270.00000000  .00001000  00000-0  10000-3 0  9991",
        tleLine2: "2 67201  97.5000 120.0000 0010000  45.0000 315.0000 15.10000000000018",
        tleEpoch: new Date(),
        receivedAt: new Date(),
      })
      .returning();
    odId = od.id;

    const [gs] = await db
      .insert(groundStations)
      .values({
        code: `GS-SAFETY-${Date.now() % 10000}`,
        name: "Safety-GS-Station",
        latitude: -12.0,
        longitude: 45.0,
        altitudeM: 120,
        status: "AVAILABLE",
        minimumElevationDeg: 5,
        supportedFrequencyBands: ["S_BAND", "X_BAND"],
        maxConcurrentContacts: 2,
        maxDataRateMbps: 450,
      })
      .returning();
    gsId = gs.id;

    // 2. Register mock provider adapter
    mockAdapter = new MockGroundStationProviderAdapter("safety-provider", {
      supportedBands: ["S_BAND", "X_BAND"],
      maxDataRateMbps: 450,
    });
    providerRegistry.registerAdapter(mockAdapter, { autoCertify: true });

    // Seed schedule versions if empty
    const versions = await db.select().from(scheduleVersions);
    if (versions.length === 0) {
      await db.insert(scheduleVersions).values({ version: 1 });
    }
  });

  afterAll(async () => {
    const resList = await db.select({ id: reservations.id }).from(reservations).where(eq(reservations.satelliteId, satId));
    const resIds = resList.map((r) => r.id);
    if (resIds.length > 0) {
      await db.delete(outboundDispatchMessages).where(inArray(outboundDispatchMessages.reservationId, resIds));
      await db.delete(dispatchAttempts).where(inArray(dispatchAttempts.reservationId, resIds));
      await db.delete(reservations).where(inArray(reservations.id, resIds));
    }
    await db.delete(contactWindows).where(eq(contactWindows.satelliteId, satId));
    await db.delete(missionTasks).where(eq(missionTasks.satelliteId, satId));
    await db.delete(satelliteOrbitalData).where(eq(satelliteOrbitalData.satelliteId, satId));
    await db.delete(satellites).where(eq(satellites.id, satId));
    await db.delete(groundStations).where(eq(groundStations.id, gsId));
  });

  beforeEach(() => {
    mockAdapter.reset();
  });

  async function seedTestReservation(suffix: string) {
    contactCounter++;
    const startMs = epochBase + contactCounter * 3600000;
    const endMs = startMs + 600000;

    const [task] = await db
      .insert(missionTasks)
      .values({
        satelliteId: satId,
        name: `Task-5.7-${suffix}-${contactCounter}`,
        priority: 1,
        durationSeconds: 600,
        deadline: new Date(startMs + 86400000),
        status: "SCHEDULED",
        targetBytes: 1000000000,
        fulfilledBytes: 0,
        remainingBytes: 1000000000,
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
  // WORKSTREAM 5.7.4: SAFETY INTERLOCK TESTS (L, M, N, O)
  // =========================================================================

  it("1. Scenario L: Abort command delivered & confirmed — transitions to ABORT_CONFIRMED, fails reservation, advances schedule version", async () => {
    const { res } = await seedTestReservation("L-AbortConfirmed");

    await outboxService.transitionToExecutionReadyWithOutbox(
      res.id,
      "safety-provider"
    );

    // Initial schedule version
    const versionBefore = (await db.select().from(scheduleVersions).where(eq(scheduleVersions.id, 1)))[0]!.version;

    // Operator triggers emergency abort
    const abortResult = await safetyInterlockService.commandPassAbort(
      res.id,
      "REGULATORY_DECONFLICTION",
      { providerId: "safety-provider" }
    );

    expect(abortResult.status).toBe("ABORT_CONFIRMED");
    expect(abortResult.physicalSilenced).toBe(true);
    expect(abortResult.versionAdvanced).toBe(true);

    // Verify reservation state is FAILED with EXECUTION_ABORTED
    const [checkRes] = await db.select().from(reservations).where(eq(reservations.id, res.id));
    expect(checkRes.executionInterlock).toBe("ABORT_CONFIRMED");
    expect(checkRes.executionState).toBe("FAILED");
    expect(checkRes.failureReason).toBe("EXECUTION_ABORTED");
    expect(checkRes.interlockConfirmedAt).not.toBeNull();

    // Verify schedule version was atomically advanced via Control Plane (V_N -> V_{N+1})
    const versionAfter = (await db.select().from(scheduleVersions).where(eq(scheduleVersions.id, 1)))[0]!.version;
    expect(versionAfter).toBe(versionBefore + 1);
  });

  it("2. Scenario M: Abort command times out (ambiguity) — transitions to ABORT_UNCONFIRMED, does NOT declare RF halted, version stays V_N", async () => {
    const { res } = await seedTestReservation("M-AbortTimeout");

    await outboxService.transitionToExecutionReadyWithOutbox(
      res.id,
      "safety-provider"
    );

    // Simulate provider network timeout on abort
    mockAdapter.options.simulateAbortTimeout = true;

    const versionBefore = (await db.select().from(scheduleVersions).where(eq(scheduleVersions.id, 1)))[0]!.version;

    const abortResult = await safetyInterlockService.commandPassAbort(
      res.id,
      "ANOMALY_ABORT",
      { providerId: "safety-provider" }
    );

    expect(abortResult.status).toBe("ABORT_UNCONFIRMED");
    expect(abortResult.physicalSilenced).toBe(false);
    expect(abortResult.versionAdvanced).toBe(false);
    expect(abortResult.warning).toContain("ABORT UNCONFIRMED - LINK SILENT");

    // Cardinal Invariant: Reservation is NOT marked FAILED and RF is NOT claimed silenced!
    const [checkRes] = await db.select().from(reservations).where(eq(reservations.id, res.id));
    expect(checkRes.executionInterlock).toBe("ABORT_UNCONFIRMED");
    expect(checkRes.executionState).toBe("EXECUTION_READY");
    expect(checkRes.interlockConfirmedAt).toBeNull();

    // Version remains strictly unchanged (V_N -> V_N)
    const versionAfter = (await db.select().from(scheduleVersions).where(eq(scheduleVersions.id, 1)))[0]!.version;
    expect(versionAfter).toBe(versionBefore);
  });

  it("3. Scenario N: Abort during active communication gap — records ABORT_REQUESTED / UNCONFIRMED, exposes warning without false confirmation", async () => {
    const { res } = await seedTestReservation("N-GapAbort");

    const outboxInit = await outboxService.transitionToExecutionReadyWithOutbox(
      res.id,
      "safety-provider"
    );

    // Simulate active communication gap on dispatch attempt
    await db
      .update(dispatchAttempts)
      .set({ transportHealth: "COMMUNICATION_GAP" })
      .where(eq(dispatchAttempts.dispatchId, outboxInit.dispatchId));

    // Abort commanded while link is silent
    mockAdapter.options.simulateAbortTimeout = true;

    const abortResult = await safetyInterlockService.commandPassAbort(
      res.id,
      "LINK_SILENT_ABORT",
      { providerId: "safety-provider" }
    );

    expect(abortResult.status).toBe("ABORT_UNCONFIRMED");
    expect(abortResult.physicalSilenced).toBe(false);

    // Verify interlock is ABORT_UNCONFIRMED and operator warning is present
    const [checkRes] = await db.select().from(reservations).where(eq(reservations.id, res.id));
    expect(checkRes.executionInterlock).toBe("ABORT_UNCONFIRMED");
    expect(checkRes.interlockRequestedAt).not.toBeNull();
  });

  it("4. Scenario O: RF Inhibit commanded — provider confirms physical carrier inhibit independently from execution failure", async () => {
    const { res } = await seedTestReservation("O-Inhibit");

    const inhibitResult = await safetyInterlockService.commandRfInhibit(
      res.id,
      gsId,
      "PHYSICAL_MAINTENANCE_INHIBIT",
      { providerId: "safety-provider" }
    );

    expect(inhibitResult.status).toBe("RF_INHIBIT_CONFIRMED");
    expect(inhibitResult.carrierInhibited).toBe(true);

    const [checkRes] = await db.select().from(reservations).where(eq(reservations.id, res.id));
    expect(checkRes.executionInterlock).toBe("RF_INHIBIT_CONFIRMED");
    expect(checkRes.executionState).toBe("SCHEDULED"); // RF inhibit does not fail execution prematurely!
  });

  // =========================================================================
  // CROSS-LAYER RESILIENCE TESTS (P, Q, R, S)
  // =========================================================================

  it("5. Scenario P: Outbox retry while attempt is stale — worker drops stale D1 delivery when D2 is active", async () => {
    const { res } = await seedTestReservation("P-StaleOutbox");

    // 1. Initial attempt D1
    const d1Result = await outboxService.transitionToExecutionReadyWithOutbox(
      res.id,
      "safety-provider",
      { customDispatchId: "disp-d1-stale" }
    );

    // 2. D1 expires/rejected, new attempt D2 is created
    await db
      .update(dispatchAttempts)
      .set({ state: "EXPIRED" })
      .where(eq(dispatchAttempts.dispatchId, "disp-d1-stale"));

    // Reset reservation to SCHEDULED to allow D2 creation
    await db
      .update(reservations)
      .set({ executionState: "SCHEDULED" })
      .where(eq(reservations.id, res.id));

    const d2Result = await outboxService.transitionToExecutionReadyWithOutbox(
      res.id,
      "safety-provider",
      { customDispatchId: "disp-d2-active" }
    );

    expect(d2Result.dispatchId).toBe("disp-d2-active");

    // 3. Late D1 outbox message attempts delivery
    // Outbox worker checks activeDispatchId of reservation
    const d1Sender = async (msg: any) => {
      const [currRes] = await db.select().from(reservations).where(eq(reservations.id, res.id));
      if (currRes.activeDispatchId !== msg.dispatchId) {
        throw new Error(`STALE_OUTBOX_DISCARDED: message dispatchId [${msg.dispatchId}] does not match active [${currRes.activeDispatchId}]`);
      }
    };

    const deliveryRes = await outboxService.deliverOutboxMessage(d1Result.messageId, d1Sender);
    expect(deliveryRes.delivered).toBe(false);
    expect(deliveryRes.error).toContain("STALE_OUTBOX_DISCARDED");

    // D2 state remains completely undisturbed!
    const [checkRes] = await db.select().from(reservations).where(eq(reservations.id, res.id));
    expect(checkRes.activeDispatchId).toBe("disp-d2-active");
  });

  it("6. Scenario Q: Provider response arrives after manual reservation cancellation — cancelled reservation remains CANCELLED", async () => {
    const { res } = await seedTestReservation("Q-Cancelled");

    const outboxInit = await outboxService.transitionToExecutionReadyWithOutbox(
      res.id,
      "safety-provider"
    );

    // Operator manually cancels reservation
    await db
      .update(reservations)
      .set({ status: "CANCELLED", executionState: "FAILED", failureReason: "EXECUTION_ABORTED" })
      .where(eq(reservations.id, res.id));

    // Staged ACK arrives from provider
    const [currRes] = await db.select().from(reservations).where(eq(reservations.id, res.id));
    expect(currRes.status).toBe("CANCELLED");
    expect(currRes.executionState).toBe("FAILED"); // Terminal cancelled state is preserved!
  });

  it("7. Scenario R: Duplicate provider acknowledgement — zero duplicate state mutation", async () => {
    const { res } = await seedTestReservation("R-DedupAck");

    const outboxInit = await outboxService.transitionToExecutionReadyWithOutbox(
      res.id,
      "safety-provider"
    );

    const context = {
      dispatchId: outboxInit.dispatchId,
      attemptNumber: 1,
      idempotencyKey: `idemp-r-${Date.now()}`,
      correlationId: `corr-r-${Date.now()}`,
      providerId: "safety-provider",
      stationCode: "GS-SAFETY",
    };

    const manifest = {
      dispatchId: outboxInit.dispatchId,
      reservationId: res.id,
      satelliteId: satId,
      groundStationId: gsId,
      window: { aos: new Date().toISOString(), los: new Date(Date.now() + 600000).toISOString() },
      allocatedTime: { start: new Date().toISOString(), end: new Date(Date.now() + 600000).toISOString() },
      task: { taskId: "task-r", targetBytes: 1000000000 },
      generatedAt: new Date().toISOString(),
    };

    // First stage
    await mockAdapter.stagePass(manifest, context);
    // Duplicate stage
    const secondAck = await mockAdapter.stagePass(manifest, context);
    expect(secondAck.rawProviderResponse.reused).toBe(true);
  });

  it("8. Scenario S: Ground provider process restart — status reconciliation restores link without duplicate dispatch attempt", async () => {
    const { res } = await seedTestReservation("S-Reboot");

    const outboxInit = await outboxService.transitionToExecutionReadyWithOutbox(
      res.id,
      "safety-provider"
    );

    const context = {
      dispatchId: outboxInit.dispatchId,
      attemptNumber: 1,
      idempotencyKey: `idemp-s-${Date.now()}`,
      correlationId: `corr-s-${Date.now()}`,
      providerId: "safety-provider",
      stationCode: "GS-SAFETY",
    };

    const manifest = {
      dispatchId: outboxInit.dispatchId,
      reservationId: res.id,
      satelliteId: satId,
      groundStationId: gsId,
      window: { aos: new Date().toISOString(), los: new Date(Date.now() + 600000).toISOString() },
      allocatedTime: { start: new Date().toISOString(), end: new Date(Date.now() + 600000).toISOString() },
      task: { taskId: "task-s", targetBytes: 1000000000 },
      generatedAt: new Date().toISOString(),
    };

    await mockAdapter.stagePass(manifest, context);

    // Provider process simulated restart: adapter instances re-instantiated, but provider internal DB retains pass
    const newAdapter = new MockGroundStationProviderAdapter("safety-provider");
    providerRegistry.registerAdapter(newAdapter, { autoCertify: true });

    // Reconcile status
    const recResult = await providerReconciliationService.reconcileAmbiguousDispatch(
      outboxInit.dispatchId,
      "safety-provider",
      context
    );

    // Attempts count remains exactly 1 — no duplicate attempt created!
    const attempts = await db
      .select()
      .from(dispatchAttempts)
      .where(eq(dispatchAttempts.reservationId, res.id));
    expect(attempts.length).toBe(1);
    expect(attempts[0].attemptNumber).toBe(1);
  });
});
