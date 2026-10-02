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
  groundStationCredentials,
} from "../db/schema";
import { outboxService } from "../modules/outbox/outbox.service";
import { MockGroundStationProviderAdapter } from "../modules/ground-provider/adapters/mock-provider.adapter";
import { providerRegistry } from "../modules/ground-provider/provider.registry";
import { providerReconciliationService } from "../modules/ground-provider/reconciliation.service";
import { groundSecurityService } from "../modules/ground-provider/crypto.service";
import { DispatchContext } from "../modules/ground-provider/provider.types";

describe("Phase 5.7: Workstream 5.7.2 & 5.7.3 — Provider Adapter & Security Provenance", () => {
  let satId: string;
  let gsId: string;
  let odId: string;
  let mockAdapter: MockGroundStationProviderAdapter;

  let activeKeyId: string;
  let activeSecretKey: string;
  let revokedKeyId: string;
  let revokedSecretKey: string;

  const epochBase = Date.now() + 800000000;
  let contactCounter = 0;

  beforeAll(async () => {
    // Clean up any stale data from interrupted runs
    const existingSats = await db.select({ id: satellites.id }).from(satellites).where(eq(satellites.noradId, 67101));
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

    // 1. Setup satellite, ground station, orbital data
    const [sat] = await db
      .insert(satellites)
      .values({
        noradId: 67101,
        name: "Provider-Sat-1",
        status: "ACTIVE",
      })
      .returning();
    satId = sat.id;

    const [od] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: satId,
        source: "CELESTRAK",
        tleLine1: "1 67101U 26001A   26270.00000000  .00001000  00000-0  10000-3 0  9991",
        tleLine2: "2 67101  97.5000 120.0000 0010000  45.0000 315.0000 15.10000000000018",
        tleEpoch: new Date(),
        receivedAt: new Date(),
      })
      .returning();
    odId = od.id;

    const [gs] = await db
      .insert(groundStations)
      .values({
        code: `GS-PROV-${Date.now() % 10000}`,
        name: "Provider-GS-Station",
        latitude: -10.0,
        longitude: 50.0,
        altitudeM: 100,
        status: "AVAILABLE",
        minimumElevationDeg: 5,
        supportedFrequencyBands: ["S_BAND", "X_BAND"],
        maxConcurrentContacts: 2,
        maxDataRateMbps: 450,
      })
      .returning();
    gsId = gs.id;

    // 2. Setup Ground Station Credentials
    activeKeyId = `key-active-${crypto.randomUUID().slice(0, 8)}`;
    activeSecretKey = crypto.randomBytes(32).toString("hex");

    await db.insert(groundStationCredentials).values({
      groundStationId: gsId,
      keyId: activeKeyId,
      secretKey: activeSecretKey,
      status: "ACTIVE",
      expiresAt: new Date(Date.now() + 86400000),
    });

    revokedKeyId = `key-revoked-${crypto.randomUUID().slice(0, 8)}`;
    revokedSecretKey = crypto.randomBytes(32).toString("hex");

    await db.insert(groundStationCredentials).values({
      groundStationId: gsId,
      keyId: revokedKeyId,
      secretKey: revokedSecretKey,
      status: "REVOKED",
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: new Date(),
    });

    // 3. Register mock provider adapter
    mockAdapter = new MockGroundStationProviderAdapter("custom-provider", {
      supportedBands: ["S_BAND", "X_BAND"],
      maxDataRateMbps: 450,
    });
    providerRegistry.registerAdapter(mockAdapter, { autoCertify: true });
  });

  afterAll(async () => {
    const resList = await db
      .select({ id: reservations.id })
      .from(reservations)
      .where(eq(reservations.satelliteId, satId));
    const resIds = resList.map((r) => r.id);
    if (resIds.length > 0) {
      await db.delete(outboundDispatchMessages).where(inArray(outboundDispatchMessages.reservationId, resIds));
      await db.delete(dispatchAttempts).where(inArray(dispatchAttempts.reservationId, resIds));
      await db.delete(reservations).where(inArray(reservations.id, resIds));
    }
    await db.delete(contactWindows).where(eq(contactWindows.satelliteId, satId));
    await db.delete(missionTasks).where(eq(missionTasks.satelliteId, satId));
    await db.delete(groundStationCredentials).where(eq(groundStationCredentials.groundStationId, gsId));
    await db.delete(satelliteOrbitalData).where(eq(satelliteOrbitalData.satelliteId, satId));
    await db.delete(satellites).where(eq(satellites.id, satId));
    await db.delete(groundStations).where(eq(groundStations.id, gsId));
  });

  beforeEach(() => {
    mockAdapter.reset();
    groundSecurityService.clearNonceCache();
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

  function createManifest(resId: string, dispatchId: string) {
    return {
      dispatchId,
      reservationId: resId,
      satelliteId: satId,
      groundStationId: gsId,
      window: {
        aos: new Date().toISOString(),
        los: new Date(Date.now() + 600000).toISOString(),
      },
      allocatedTime: {
        start: new Date().toISOString(),
        end: new Date(Date.now() + 600000).toISOString(),
      },
      task: {
        taskId: "task-1",
        targetBytes: 1000000000,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  // =========================================================================
  // WORKSTREAM 5.7.2: PROVIDER ADAPTER TESTS (D, E, F, G & RECONCILIATION)
  // =========================================================================

  it("1. Scenario D: Provider accepts stage — returns canonical StagedPassReceipt", async () => {
    const { res } = await seedTestReservation("D-Accept");

    const outboxInit = await outboxService.transitionToExecutionReadyWithOutbox(
      res.id,
      "custom-provider"
    );

    const context: DispatchContext = {
      dispatchId: outboxInit.dispatchId,
      attemptNumber: outboxInit.attemptNumber,
      idempotencyKey: `idemp-d-${Date.now()}`,
      correlationId: `corr-d-${Date.now()}`,
      providerId: "custom-provider",
      stationCode: "GS-PROV",
    };

    const manifest = createManifest(res.id, outboxInit.dispatchId);
    const receipt = await mockAdapter.stagePass(manifest, context);

    expect(receipt.providerDispatchRef).toContain(outboxInit.dispatchId);
    expect(receipt.stationStatus).toBe("READY");

    // Arming pass
    const armedReceipt = await mockAdapter.armPass(outboxInit.dispatchId, context);
    expect(armedReceipt.trackingConfigured).toBe(true);

    // Poll status returns ARMED
    const snapshot = await mockAdapter.pollPassStatus(outboxInit.dispatchId, context);
    expect(snapshot.state).toBe("ARMED");
    expect(snapshot.carrierLocked).toBe(true);
  });

  it("2. Scenario E: Provider rejects stage — returns canonical physical rejection error", async () => {
    const { res } = await seedTestReservation("E-Reject");

    mockAdapter.options.simulateStageRejection = true;
    mockAdapter.options.stageRejectionReason = "HARDWARE_TRANSMITTER_OFFLINE";

    const outboxInit = await outboxService.transitionToExecutionReadyWithOutbox(
      res.id,
      "custom-provider"
    );

    const context: DispatchContext = {
      dispatchId: outboxInit.dispatchId,
      attemptNumber: outboxInit.attemptNumber,
      idempotencyKey: `idemp-e-${Date.now()}`,
      correlationId: `corr-e-${Date.now()}`,
      providerId: "custom-provider",
      stationCode: "GS-PROV",
    };

    const manifest = createManifest(res.id, outboxInit.dispatchId);
    await expect(mockAdapter.stagePass(manifest, context)).rejects.toThrow(
      "HARDWARE_TRANSMITTER_OFFLINE"
    );
  });

  it("3. Scenario F: Ambiguous outcome reconciliation — timeout followed by polling reconciles STAGED_ACK without duplicate dispatch", async () => {
    const { res } = await seedTestReservation("F-Ambiguous");

    // Configure mock provider: stages pass internally, but network drops before response reaches OrbitMesh!
    mockAdapter.options.simulateStageTimeout = true;

    const outboxInit = await outboxService.transitionToExecutionReadyWithOutbox(
      res.id,
      "custom-provider"
    );

    const context: DispatchContext = {
      dispatchId: outboxInit.dispatchId,
      attemptNumber: outboxInit.attemptNumber,
      idempotencyKey: `idemp-f-${Date.now()}`,
      correlationId: `corr-f-${Date.now()}`,
      providerId: "custom-provider",
      stationCode: "GS-PROV",
    };

    const manifest = createManifest(res.id, outboxInit.dispatchId);

    // Initial call throws provider timeout
    await expect(mockAdapter.stagePass(manifest, context)).rejects.toThrow(
      "HTTP_PROVIDER_TIMEOUT"
    );

    // Cardinal Invariant: Ambiguity is NOT failure!
    // Attempt remains PREPARED in DB, reservation remains EXECUTION_READY
    let [checkAttempt] = await db
      .select()
      .from(dispatchAttempts)
      .where(eq(dispatchAttempts.dispatchId, outboxInit.dispatchId));
    expect(checkAttempt.state).toBe("PREPARED");

    // Reconciliation service polls external provider
    const recResult = await providerReconciliationService.reconcileAmbiguousDispatch(
      outboxInit.dispatchId,
      "custom-provider",
      context
    );

    expect(recResult.reconciled).toBe(true);
    expect(recResult.outcome).toBe("STAGED_ACK");

    // Verify DB attempt was updated to STAGED_ACK with transportHealth CONNECTED
    [checkAttempt] = await db
      .select()
      .from(dispatchAttempts)
      .where(eq(dispatchAttempts.dispatchId, outboxInit.dispatchId));
    expect(checkAttempt.state).toBe("STAGED_ACK");
    expect(checkAttempt.transportHealth).toBe("CONNECTED");

    // Verify reservation is STILL EXECUTION_READY (no duplicate creation!)
    const [checkRes] = await db.select().from(reservations).where(eq(reservations.id, res.id));
    expect(checkRes.executionState).toBe("EXECUTION_READY");
    expect(checkRes.activeDispatchId).toBe(outboxInit.dispatchId);
  });

  it("4. Scenario G: Provider returns duplicate response — existing dispatch identity is reused idempotently", async () => {
    const { res } = await seedTestReservation("G-Duplicate");

    const outboxInit = await outboxService.transitionToExecutionReadyWithOutbox(
      res.id,
      "custom-provider"
    );

    const context: DispatchContext = {
      dispatchId: outboxInit.dispatchId,
      attemptNumber: outboxInit.attemptNumber,
      idempotencyKey: `idemp-g-${Date.now()}`,
      correlationId: `corr-g-${Date.now()}`,
      providerId: "custom-provider",
      stationCode: "GS-PROV",
    };

    const manifest = createManifest(res.id, outboxInit.dispatchId);

    // Call 1
    const receipt1 = await mockAdapter.stagePass(manifest, context);
    // Call 2 with identical context & manifest
    const receipt2 = await mockAdapter.stagePass(manifest, context);

    expect(receipt1.providerDispatchRef).toBe(receipt2.providerDispatchRef);
    expect(receipt2.rawProviderResponse.reused).toBe(true);
  });

  it("5. Provider Capability Discovery: validates frequency band & data rate compatibility", async () => {
    // Compatible band (S_BAND) & rate (300 Mbps <= 450 Mbps)
    const validResult = await mockAdapter.validateCapabilities(gsId, {
      frequencyBand: "S_BAND",
      dataRateMbps: 300,
    });
    expect(validResult.isCompatible).toBe(true);
    expect(validResult.unsupportedBands.length).toBe(0);

    // Incompatible band (UHF not in S_BAND, X_BAND)
    const invalidBandResult = await mockAdapter.validateCapabilities(gsId, {
      frequencyBand: "UHF",
      dataRateMbps: 50,
    });
    expect(invalidBandResult.isCompatible).toBe(false);
    expect(invalidBandResult.unsupportedBands).toContain("UHF");

    // Incompatible data rate (600 Mbps > 450 Mbps max)
    const invalidRateResult = await mockAdapter.validateCapabilities(gsId, {
      frequencyBand: "X_BAND",
      dataRateMbps: 600,
    });
    expect(invalidRateResult.isCompatible).toBe(false);
    expect(invalidRateResult.maxDataRateFeasible).toBe(false);
  });

  // =========================================================================
  // WORKSTREAM 5.7.3: AUTHENTICATION & PROVENANCE TESTS (H, I, J, K)
  // =========================================================================

  it("6. Scenario H: Valid authenticated telemetry — verified via active key HMAC signature", async () => {
    const dispatchId = `disp-auth-${Date.now()}`;
    const seq = 1;
    const timestamp = new Date().toISOString();
    const nonce = `nonce-${crypto.randomUUID()}`;
    const payload = { carrierLocked: true, snrDb: 18.5, bytesTransferred: 5000000 };

    const canonical = groundSecurityService.buildCanonicalString(
      dispatchId,
      seq,
      timestamp,
      nonce,
      payload
    );

    const signature = groundSecurityService.generateSignature(activeSecretKey, canonical);

    const result = await groundSecurityService.verifyTelemetrySignature(
      {
        keyId: activeKeyId,
        signature,
        nonce,
        timestamp,
      },
      dispatchId,
      seq,
      payload
    );

    expect(result.isValid).toBe(true);
    expect(result.stationId).toBe(gsId);
    expect(result.keyId).toBe(activeKeyId);
  });

  it("7. Scenario I: Invalid HMAC signature — rejected with INVALID_SIGNATURE", async () => {
    const dispatchId = `disp-tamper-${Date.now()}`;
    const seq = 1;
    const timestamp = new Date().toISOString();
    const nonce = `nonce-${crypto.randomUUID()}`;
    const payload = { carrierLocked: true, bytesTransferred: 10000 };

    // Attacker generates signature using wrong secret key
    const badSecretKey = crypto.randomBytes(32).toString("hex");
    const canonical = groundSecurityService.buildCanonicalString(
      dispatchId,
      seq,
      timestamp,
      nonce,
      payload
    );
    const forgedSignature = groundSecurityService.generateSignature(badSecretKey, canonical);

    const result = await groundSecurityService.verifyTelemetrySignature(
      {
        keyId: activeKeyId,
        signature: forgedSignature,
        nonce,
        timestamp,
      },
      dispatchId,
      seq,
      payload
    );

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe("INVALID_SIGNATURE");
  });

  it("8. Scenario J: Revoked station credential — rejected with CREDENTIAL_REVOKED", async () => {
    const dispatchId = `disp-revoked-${Date.now()}`;
    const seq = 1;
    const timestamp = new Date().toISOString();
    const nonce = `nonce-${crypto.randomUUID()}`;
    const payload = { carrierLocked: true };

    const canonical = groundSecurityService.buildCanonicalString(
      dispatchId,
      seq,
      timestamp,
      nonce,
      payload
    );
    const signature = groundSecurityService.generateSignature(revokedSecretKey, canonical);

    const result = await groundSecurityService.verifyTelemetrySignature(
      {
        keyId: revokedKeyId,
        signature,
        nonce,
        timestamp,
      },
      dispatchId,
      seq,
      payload
    );

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe("CREDENTIAL_REVOKED");
  });

  it("9. Scenario K: Replay of previously authenticated packet — rejected with NONCE_REPLAY_DETECTED", async () => {
    const dispatchId = `disp-replay-${Date.now()}`;
    const seq = 1;
    const timestamp = new Date().toISOString();
    const reusedNonce = `nonce-reused-${Date.now()}`;
    const payload = { carrierLocked: true, bytesTransferred: 25000000 };

    const canonical = groundSecurityService.buildCanonicalString(
      dispatchId,
      seq,
      timestamp,
      reusedNonce,
      payload
    );
    const signature = groundSecurityService.generateSignature(activeSecretKey, canonical);

    // Call 1: Valid initial packet
    const firstAttempt = await groundSecurityService.verifyTelemetrySignature(
      {
        keyId: activeKeyId,
        signature,
        nonce: reusedNonce,
        timestamp,
      },
      dispatchId,
      seq,
      payload
    );
    expect(firstAttempt.isValid).toBe(true);

    // Call 2: Replay of exact same nonce
    const replayAttempt = await groundSecurityService.verifyTelemetrySignature(
      {
        keyId: activeKeyId,
        signature,
        nonce: reusedNonce,
        timestamp,
      },
      dispatchId,
      seq,
      payload
    );

    expect(replayAttempt.isValid).toBe(false);
    expect(replayAttempt.errorCode).toBe("NONCE_REPLAY_DETECTED");
  });

  it("10. Security Boundary: Excessive timestamp skew rejected with CLOCK_SKEW_EXCEEDED", async () => {
    const dispatchId = `disp-skew-${Date.now()}`;
    const seq = 1;
    // 15 seconds in future (exceeds ±5s tolerance)
    const futureTimestamp = new Date(Date.now() + 15000).toISOString();
    const nonce = `nonce-${crypto.randomUUID()}`;
    const payload = { carrierLocked: true };

    const canonical = groundSecurityService.buildCanonicalString(
      dispatchId,
      seq,
      futureTimestamp,
      nonce,
      payload
    );
    const signature = groundSecurityService.generateSignature(activeSecretKey, canonical);

    const result = await groundSecurityService.verifyTelemetrySignature(
      {
        keyId: activeKeyId,
        signature,
        nonce,
        timestamp: futureTimestamp,
      },
      dispatchId,
      seq,
      payload
    );

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe("CLOCK_SKEW_EXCEEDED");
  });
});
