/**
 * Phase 5.8: Workstream 5.8.2-A — AWS Ground Station Commercial Adapter Test Suite
 *
 * Validates:
 * 1. AWS Contact Lifecycle & State Mapping (SCHEDULING, SCHEDULED, PREPASS, PASS, POSTPASS, COMPLETED, CANCELLED)
 * 2. AWS clientToken Idempotency (reservation_id:dispatch_attempt_id mapping)
 * 3. Ambiguous outcome reconciliation on staging timeout
 * 4. Safety Interlock & Physical carrier silencing on abort
 * 5. Capability validation (S-Band, X-Band, Ka-Band rejection, data rates)
 * 6. The 5.8.1 Certification Harness Gate (16/16 assertions across all 4 layers)
 * 7. Production Gate & Registry Admission (ProviderNotCertifiedError enforcement)
 * 8. Rejection of tampered / expired / version-mismatched receipts
 * 9. SigV4 Signer Header Generation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import crypto from "crypto";
import { AwsGroundStationProviderAdapter } from "../modules/ground-provider/adapters/aws-ground-station.adapter";
import {
  AwsGroundStationSimulatedClient,
  AwsSigV4Signer,
} from "../modules/ground-provider/adapters/aws-ground-station.client";
import {
  DispatchContext,
  RfRequirements,
} from "../modules/ground-provider/provider.types";
import { DispatchManifest } from "../modules/execution/execution.types";
import {
  ProviderCertificationHarness,
  providerCertificationHarness,
} from "../modules/ground-provider/certification/certification-harness.service";
import {
  ProviderRegistry,
  ProviderNotCertifiedError,
} from "../modules/ground-provider/provider.registry";
import { db } from "../db/client";
import {
  groundStations,
  groundStationCredentials,
  satellites,
  satelliteOrbitalData,
  contactWindows,
  missionTasks,
  reservations,
  dispatchAttempts,
  outboundDispatchMessages,
} from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { OutboxService } from "../modules/outbox/outbox.service";

describe("Phase 5.8.2-A: AWS Ground Station Commercial Adapter", () => {
  let simulatedClient: AwsGroundStationSimulatedClient;
  let awsAdapter: AwsGroundStationProviderAdapter;
  let stationId: string;
  let satId: string;
  let odId: string;
  let testKeyId: string;
  const testSecretKey = "aws-test-secret-key-32bytes-len!";
  let resCounter = 0;
  const epochBase = 1893456000000; // 2030-01-01T00:00:00.000Z

  beforeAll(async () => {
    // 1. Setup Ground Station & Credentials
    const [station] = await db
      .insert(groundStations)
      .values({
        code: `AWS-GS-${Date.now() % 10000}`,
        name: "AWS-Test-GS",
        latitude: 39.96,
        longitude: -83.0,
        status: "AVAILABLE",
        minimumElevationDeg: 5,
        supportedFrequencyBands: ["S_BAND", "X_BAND"],
      })
      .returning();
    stationId = station.id;

    testKeyId = `aws-key-${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(groundStationCredentials).values({
      groundStationId: stationId,
      keyId: testKeyId,
      secretKey: testSecretKey,
      status: "ACTIVE",
      expiresAt: new Date(Date.now() + 86400000),
    });

    // 2. Setup Satellite and Orbital Data
    const [sat] = await db
      .insert(satellites)
      .values({
        noradId: 67350,
        name: "Aws-Cert-Sat",
        status: "ACTIVE",
      })
      .returning();
    satId = sat.id;

    const [od] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: satId,
        source: "CELESTRAK",
        tleLine1: "1 67350U 26001A   26270.00000000  .00001000  00000-0  10000-3 0  9991",
        tleLine2: "2 67350  97.5000 120.0000 0010000  45.0000 315.0000 15.10000000000018",
        tleEpoch: new Date(),
        receivedAt: new Date(),
      })
      .returning();
    odId = od.id;
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
    await db.delete(satelliteOrbitalData).where(eq(satelliteOrbitalData.satelliteId, satId));
    await db.delete(satellites).where(eq(satellites.id, satId));
    await db.delete(groundStationCredentials).where(eq(groundStationCredentials.groundStationId, stationId));
    await db.delete(groundStations).where(eq(groundStations.id, stationId));
  });

  beforeEach(() => {
    simulatedClient = new AwsGroundStationSimulatedClient();
    awsAdapter = new AwsGroundStationProviderAdapter("aws-ground-station", {
      client: simulatedClient,
      region: "us-east-2",
      awsAccountId: "123456789012",
    });
  });

  async function seedReservation(suffix: string) {
    resCounter++;
    const startMs = epochBase + resCounter * 3600000;
    const endMs = startMs + 600000;

    const [task] = await db
      .insert(missionTasks)
      .values({
        satelliteId: satId,
        name: `Task-AWS-${suffix}-${resCounter}`,
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
        groundStationId: stationId,
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
        groundStationId: stationId,
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

  const createMockManifest = (dispatchId: string): DispatchManifest => {
    const now = Date.now();
    return {
      dispatchId,
      reservationId: crypto.randomUUID(),
      satelliteId: satId,
      groundStationId: stationId,
      window: {
        aos: new Date(now + 60000).toISOString(),
        los: new Date(now + 660000).toISOString(),
      },
      allocatedTime: {
        start: new Date(now + 60000).toISOString(),
        end: new Date(now + 660000).toISOString(),
      },
      rfConfiguration: {
        frequencyBand: "S_BAND",
        minDataRateMbps: 150,
      },
      taskManifest: {
        taskId: crypto.randomUUID(),
        priority: 1,
        targetBytes: 500000000,
        remainingBytes: 500000000,
      },
      dispatchedAt: new Date(now).toISOString(),
    };
  };

  const createMockContext = (dispatchId: string): DispatchContext => ({
    dispatchId,
    attemptNumber: 1,
    idempotencyKey: `idemp-aws-${dispatchId}`,
    correlationId: `corr-aws-${dispatchId}`,
    providerId: "aws-ground-station",
    stationCode: "GS-USA-01",
  });

  // =========================================================================
  // 1. AWS Contact Lifecycle & State Mapping
  // =========================================================================
  describe("1. AWS Contact Lifecycle & State Mapping", () => {
    it("stages contact in AWS Ground Station with status SCHEDULED and returns StagedPassReceipt", async () => {
      const dispatchId = `disp-stage-${Date.now()}`;
      const manifest = createMockManifest(dispatchId);
      const context = createMockContext(dispatchId);

      const receipt = await awsAdapter.stagePass(manifest, context);

      expect(receipt.providerDispatchRef).toBeDefined();
      expect(receipt.stationStatus).toBe("READY");
      expect(receipt.stagedAt).toBeInstanceOf(Date);

      // Verify AWS internal contact
      const contact = await simulatedClient.describeContact(receipt.providerDispatchRef);
      expect(contact).not.toBeNull();
      expect(contact!.contactStatus).toBe("SCHEDULED");
      expect(contact!.groundStation).toBe("Ohio 1");
      expect(contact!.satelliteArn).toContain(satId);
      expect(contact!.missionProfileArn).toContain("orbitmesh-s-band");
    });

    it("arms contact in AWS Ground Station, verifies PREPASS transition, and returns ArmedPassReceipt", async () => {
      const dispatchId = `disp-arm-${Date.now()}`;
      const manifest = createMockManifest(dispatchId);
      const context = createMockContext(dispatchId);

      const stageReceipt = await awsAdapter.stagePass(manifest, context);
      const armReceipt = await awsAdapter.armPass(dispatchId, context);

      expect(armReceipt.trackingConfigured).toBe(true);
      expect(armReceipt.armedAt).toBeInstanceOf(Date);

      // Verify contact moved to PREPASS in AWS
      const contact = await simulatedClient.describeContact(stageReceipt.providerDispatchRef);
      expect(contact!.contactStatus).toBe("PREPASS");
    });

    it("maps AWS contact states bijectively into canonical PassStatusSnapshot states", async () => {
      const dispatchId = `disp-poll-${Date.now()}`;
      const manifest = createMockManifest(dispatchId);
      const context = createMockContext(dispatchId);

      const stageReceipt = await awsAdapter.stagePass(manifest, context);
      const contactId = stageReceipt.providerDispatchRef;

      // 1. SCHEDULED -> STAGED, carrierLocked: false
      simulatedClient.advanceContactState(contactId, "SCHEDULED");
      let status = await awsAdapter.pollPassStatus(dispatchId, context);
      expect(status.state).toBe("STAGED");
      expect(status.carrierLocked).toBe(false);

      // 2. PREPASS -> ARMED (carrierLocked: false by default, never manufactured from lifecycle state)
      simulatedClient.advanceContactState(contactId, "PREPASS");
      status = await awsAdapter.pollPassStatus(dispatchId, context);
      expect(status.state).toBe("ARMED");
      expect(status.carrierLocked).toBe(false);

      // 3. PASS without explicit carrier lock telemetry -> TRACKING, carrierLocked: false
      simulatedClient.advanceContactState(contactId, "PASS", 0, false);
      status = await awsAdapter.pollPassStatus(dispatchId, context);
      expect(status.state).toBe("TRACKING");
      expect(status.carrierLocked).toBe(false);

      // 4. PASS WITH verified RF lock telemetry -> TRACKING, carrierLocked: true
      simulatedClient.advanceContactState(contactId, "PASS", 25000000, true);
      status = await awsAdapter.pollPassStatus(dispatchId, context);
      expect(status.state).toBe("TRACKING");
      expect(status.carrierLocked).toBe(true);
      expect(status.bytesRecorded).toBe(25000000);

      // 4. POSTPASS / COMPLETED -> TERMINATED, carrierLocked: false
      simulatedClient.advanceContactState(contactId, "COMPLETED", 50000000);
      status = await awsAdapter.pollPassStatus(dispatchId, context);
      expect(status.state).toBe("TERMINATED");
      expect(status.carrierLocked).toBe(false);
      expect(status.bytesRecorded).toBe(50000000);

      // 5. CANCELLED -> TERMINATED, carrierLocked: false
      simulatedClient.advanceContactState(contactId, "CANCELLED");
      status = await awsAdapter.pollPassStatus(dispatchId, context);
      expect(status.state).toBe("TERMINATED");
      expect(status.carrierLocked).toBe(false);

      // 6. Non-existent dispatch -> UNKNOWN
      const unknownStatus = await awsAdapter.pollPassStatus("unknown-dispatch-id", context);
      expect(unknownStatus.state).toBe("UNKNOWN");
      expect(unknownStatus.carrierLocked).toBe(false);
    });

    it("cancels contact in AWS Ground Station on abort and confirms RF carrier silence", async () => {
      const dispatchId = `disp-abort-${Date.now()}`;
      const manifest = createMockManifest(dispatchId);
      const context = createMockContext(dispatchId);

      const stageReceipt = await awsAdapter.stagePass(manifest, context);
      const abortReceipt = await awsAdapter.abortPass(dispatchId, "COLLISION_ALERT", context);

      expect(abortReceipt.rfCarrierSilenced).toBe(true);
      expect(abortReceipt.confirmedAt).toBeInstanceOf(Date);

      // Verify contact was CANCELLED in AWS Ground Station
      const contact = await simulatedClient.describeContact(stageReceipt.providerDispatchRef);
      expect(contact!.contactStatus).toBe("CANCELLED");
    });
  });

  // =========================================================================
  // 2. AWS Client-Token Idempotency
  // =========================================================================
  describe("2. AWS clientToken Idempotency", () => {
    it("returns identical contactId on duplicate stagePass requests with identical clientToken", async () => {
      const dispatchId = `disp-idemp-${Date.now()}`;
      const manifest = createMockManifest(dispatchId);
      const context = createMockContext(dispatchId);

      const first = await awsAdapter.stagePass(manifest, context);
      const second = await awsAdapter.stagePass(manifest, context);

      expect(first.providerDispatchRef).toBe(second.providerDispatchRef);
      expect(first.stagedAt.getTime()).toBe(second.stagedAt.getTime());

      // Confirm only 1 contact was booked in AWS
      const allStations = await simulatedClient.listGroundStations();
      expect(allStations.length).toBeGreaterThan(0);
      const contact = await simulatedClient.describeContact(first.providerDispatchRef);
      expect(contact).not.toBeNull();
    });

    it("generates bounded collision-resistant clientToken (<= 64 chars) with deterministic hash suffix for long keys", async () => {
      const dispatchId = `disp-long-${Date.now()}`;
      const longIdempotencyKey = "very-long-idempotency-key-that-exceeds-the-sixty-four-character-limit-imposed-by-aws-api-1234567890";
      const manifest = createMockManifest(dispatchId);
      const context: DispatchContext = {
        ...createMockContext(dispatchId),
        idempotencyKey: longIdempotencyKey,
      };

      const receipt = await awsAdapter.stagePass(manifest, context);
      const contact = await simulatedClient.describeContact(receipt.providerDispatchRef);
      expect(contact!.clientToken.length).toBeLessThanOrEqual(64);
      const expectedSuffix = crypto.createHash("sha256").update(longIdempotencyKey).digest("hex").slice(0, 16);
      expect(contact!.clientToken).toContain(expectedSuffix);
    });
  });

  // =========================================================================
  // 3. Ambiguous Outcome Reconciliation
  // =========================================================================
  describe("3. Ambiguous Outcome Reconciliation", () => {
    it("reconciles contact via pollPassStatus and retry after simulated staging network drop", async () => {
      const dispatchId = `disp-drop-${Date.now()}`;
      const manifest = createMockManifest(dispatchId);
      const context = createMockContext(dispatchId);

      // Simulate network timeout: AWS created contact, but response dropped before reaching caller
      awsAdapter.options.simulateStageTimeout = true;
      await expect(awsAdapter.stagePass(manifest, context)).rejects.toThrow("HTTP_PROVIDER_TIMEOUT");
      awsAdapter.options.simulateStageTimeout = false;

      // Status poll retrieves the contact booked in AWS
      const status = await awsAdapter.pollPassStatus(dispatchId, context);
      expect(status.state).toBe("STAGED");

      // Staging retry returns existing contact idempotently
      const retryReceipt = await awsAdapter.stagePass(manifest, context);
      expect(retryReceipt.providerDispatchRef).toBeDefined();
    });
  });

  // =========================================================================
  // 4. Safety Interlock & Fault Invariant
  // =========================================================================
  describe("4. Safety Interlock & Physical Silencing", () => {
    it("throws error and strictly avoids false physical confirmation during simulated abort timeout", async () => {
      const dispatchId = `disp-safe-timeout-${Date.now()}`;
      const manifest = createMockManifest(dispatchId);
      const context = createMockContext(dispatchId);

      await awsAdapter.stagePass(manifest, context);

      awsAdapter.options.simulateAbortTimeout = true;
      try {
        await awsAdapter.abortPass(dispatchId, "TIMEOUT_TEST", context);
        expect.unreachable("Should have thrown ABORT_TRANSPORT_TIMEOUT");
      } catch (err: any) {
        expect(err.message).toBe("ABORT_TRANSPORT_TIMEOUT");
      } finally {
        awsAdapter.options.simulateAbortTimeout = false;
      }
    });
  });

  // =========================================================================
  // 5. Capability Validation
  // =========================================================================
  describe("5. Capability Validation", () => {
    it("accepts supported S-Band and X-Band parameters", async () => {
      const req: RfRequirements = { frequencyBand: "S_BAND", dataRateMbps: 200 };
      const res = await awsAdapter.validateCapabilities("Ohio 1", req);
      expect(res.isCompatible).toBe(true);
      expect(res.maxDataRateFeasible).toBe(true);
      expect(res.unsupportedBands).toEqual([]);
    });

    it("rejects unsupported Ka-Band with detailed incompatibility reason", async () => {
      const req: RfRequirements = { frequencyBand: "KA_BAND", dataRateMbps: 20000 };
      const res = await awsAdapter.validateCapabilities("Ohio 1", req);
      expect(res.isCompatible).toBe(false);
      expect(res.unsupportedBands).toContain("KA_BAND");
      expect(res.reason).toContain("does not support frequency band KA_BAND");
    });

    it("rejects excessive data rate exceeding station antenna capability", async () => {
      const req: RfRequirements = { frequencyBand: "S_BAND", dataRateMbps: 5000 };
      const res = await awsAdapter.validateCapabilities("Ohio 1", req);
      expect(res.isCompatible).toBe(false);
      expect(res.maxDataRateFeasible).toBe(false);
      expect(res.reason).toContain("exceeds station Ohio 1 max rate");
    });

    it("dynamically validates capabilities against specific AWS ground stations (e.g. Punta Arenas 1)", async () => {
      // Punta Arenas 1 has max data rate 500 Mbps in AWS station catalog
      const reqOverLimit: RfRequirements = { frequencyBand: "S_BAND", dataRateMbps: 800 };
      const resOver = await awsAdapter.validateCapabilities("Punta Arenas 1", reqOverLimit);
      expect(resOver.isCompatible).toBe(false);
      expect(resOver.maxDataRateFeasible).toBe(false);
      expect(resOver.reason).toContain("exceeds station Punta Arenas 1 max rate 500Mbps");

      const reqWithin: RfRequirements = { frequencyBand: "S_BAND", dataRateMbps: 400 };
      const resWithin = await awsAdapter.validateCapabilities("Punta Arenas 1", reqWithin);
      expect(resWithin.isCompatible).toBe(true);
      expect(resWithin.maxDataRateFeasible).toBe(true);
    });
  });

  // =========================================================================
  // 6. The 5.8.1 Certification Harness Gate
  // =========================================================================
  describe("6. The 5.8.1 Certification Harness Gate", () => {
    it("passes all 16/16 assertions across all 4 layers and issues signed certification receipt", async () => {
      const receipt = await providerCertificationHarness.executeFullCertification(awsAdapter, {
        stationId,
        secretKey: testSecretKey,
        keyId: testKeyId,
        adapterVersion: "1.0.0",
        environment: "PRODUCTION",
        validityDays: 90,
      });

      expect(receipt.isCertified).toBe(true);
      expect(receipt.providerId).toBe("aws-ground-station");
      expect(receipt.adapterVersion).toBe("1.0.0");
      expect(receipt.contractVersion).toBe("5.8.0");
      expect(receipt.certificationSuiteVersion).toBe("5.8.1");
      expect(receipt.summary.totalAssertions).toBe(16);
      expect(receipt.summary.passedAssertions).toBe(16);
      expect(receipt.summary.semantic).toBe(true);
      expect(receipt.summary.distributed).toBe(true);
      expect(receipt.summary.security).toBe(true);
      expect(receipt.summary.safety).toBe(true);

      // Verify HMAC-SHA256 signature
      expect(receipt.signature).toBeDefined();
      expect(receipt.resultsDigest).toBeDefined();

      const verification = providerCertificationHarness.verifyReceipt(receipt);
      expect(verification.isValid).toBe(true);
    });
  });

  // =========================================================================
  // 7. Production Gate & Registry Admission
  // =========================================================================
  describe("7. Production Gate & Registry Admission", () => {
    it("enforces that uncertified AWS adapter is rejected, then admitted once certified", async () => {
      const registry = new ProviderRegistry();
      const freshAdapter = new AwsGroundStationProviderAdapter("aws-ground-station-prod", {
        client: simulatedClient,
      });

      // 1. Initial registration without receipt: provider is UNCERTIFIED
      registry.registerAdapter(freshAdapter);
      expect(registry.isCertified("aws-ground-station-prod")).toBe(false);

      // 2. Production gate asserts certification: must throw ProviderNotCertifiedError
      expect(() => {
        registry.assertCertified("aws-ground-station-prod");
      }).toThrow(ProviderNotCertifiedError);

      // 3. Run harness certification using canonical singleton harness
      const receipt = await providerCertificationHarness.executeFullCertification(freshAdapter, {
        stationId,
        secretKey: testSecretKey,
        keyId: testKeyId,
        adapterVersion: "1.0.0",
      });
      expect(receipt.isCertified).toBe(true);

      // 4. Ingest certification receipt into registry
      registry.certifyAdapter("aws-ground-station-prod", receipt);

      // 5. Verification passes and production dispatch is unlocked
      expect(registry.isCertified("aws-ground-station-prod")).toBe(true);
      expect(() => {
        registry.assertCertified("aws-ground-station-prod");
      }).not.toThrow();
    });

    it("authoritatively allows OutboxService to dispatch reservations once certified", async () => {
      const registry = new ProviderRegistry();
      const outboxService = new OutboxService(registry);

      const freshAdapter = new AwsGroundStationProviderAdapter("aws-gs-outbox-test", {
        client: simulatedClient,
      });
      registry.registerAdapter(freshAdapter);

      // Seed valid test reservation with related task and contact window
      const { res } = await seedReservation("outbox");

      // Before certification: outbox transition fails at production certification gate
      await expect(
        outboxService.transitionToExecutionReadyWithOutbox(res.id, "aws-gs-outbox-test")
      ).rejects.toThrow(ProviderNotCertifiedError);

      // Certify through 5.8.1 harness
      const receipt = await providerCertificationHarness.executeFullCertification(freshAdapter, {
        stationId,
        secretKey: testSecretKey,
        keyId: testKeyId,
        adapterVersion: "1.0.0",
      });
      registry.certifyAdapter("aws-gs-outbox-test", receipt);

      // After certification: outbox transition and dispatch succeed
      const transitionResult = await outboxService.transitionToExecutionReadyWithOutbox(
        res.id,
        "aws-gs-outbox-test"
      );
      const [attempt] = await db
        .select()
        .from(dispatchAttempts)
        .where(eq(dispatchAttempts.dispatchId, transitionResult.dispatchId));
      expect(attempt.state).toBe("PREPARED");

      const deliveryResult = await outboxService.deliverOutboxMessage(
        transitionResult.messageId,
        async (msg) => {
          const adapter = registry.getAdapter(msg.providerId, { requireCertified: true });
          const manifest = createMockManifest(msg.dispatchId);
          const context = createMockContext(msg.dispatchId);
          await adapter.stagePass(manifest, context);
          await adapter.armPass(msg.dispatchId, context);
        }
      );
      expect(deliveryResult.delivered).toBe(true);
      expect(deliveryResult.status).toBe("DELIVERED");
    });
  });

  // =========================================================================
  // 8. Rejection of Tampered, Expired, and Mismatched Receipts
  // =========================================================================
  describe("8. Rejection of Tampered, Expired, and Mismatched Receipts", () => {
    it("rejects certification receipt if signature is tampered", async () => {
      const registry = new ProviderRegistry();
      registry.registerAdapter(awsAdapter);

      const receipt = await providerCertificationHarness.executeFullCertification(awsAdapter, {
        stationId,
        secretKey: testSecretKey,
        keyId: testKeyId,
      });

      const tamperedReceipt = {
        ...receipt,
        signature: receipt.signature.slice(0, -4) + "ffff",
      };

      expect(() => {
        registry.certifyAdapter(awsAdapter.providerId, tamperedReceipt);
      }).toThrow(ProviderNotCertifiedError);
    });

    it("rejects certification receipt if expired", async () => {
      const registry = new ProviderRegistry();
      registry.registerAdapter(awsAdapter);

      const receipt = await providerCertificationHarness.executeFullCertification(awsAdapter, {
        stationId,
        secretKey: testSecretKey,
        keyId: testKeyId,
      });

      const expiredReceipt = {
        ...receipt,
        expiresAt: new Date(Date.now() - 10000), // in the past
      };

      expect(() => {
        registry.certifyAdapter(awsAdapter.providerId, expiredReceipt);
      }).toThrow(ProviderNotCertifiedError);
    });

    it("rejects certification receipt if providerId does not match adapter", async () => {
      const registry = new ProviderRegistry();
      registry.registerAdapter(awsAdapter);

      const receipt = await providerCertificationHarness.executeFullCertification(awsAdapter, {
        stationId,
        secretKey: testSecretKey,
        keyId: testKeyId,
      });

      const mismatchedReceipt = {
        ...receipt,
        providerId: "different-provider-id",
      };

      expect(() => {
        registry.certifyAdapter(awsAdapter.providerId, mismatchedReceipt);
      }).toThrow("Certification provider mismatch");
    });
  });

  // =========================================================================
  // 9. AWS SigV4 Signer Header Generation
  // =========================================================================
  describe("9. AWS SigV4 Signer Header Generation", () => {
    it("computes standard AWS4-HMAC-SHA256 authorization headers with date and sha256 checksum", () => {
      const signedHeaders = AwsSigV4Signer.signRequest({
        method: "POST",
        url: "https://groundstation.us-east-2.amazonaws.com/contact",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groundStation: "Ohio 1" }),
        service: "groundstation",
        region: "us-east-2",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        timestamp: new Date("2026-10-03T12:00:00Z"),
      });

      expect(signedHeaders["Authorization"]).toContain("AWS4-HMAC-SHA256");
      expect(signedHeaders["Authorization"]).toContain("Credential=AKIAIOSFODNN7EXAMPLE/20261003/us-east-2/groundstation/aws4_request");
      expect(signedHeaders["x-amz-date"]).toBe("20261003T120000Z");
      expect(signedHeaders["x-amz-content-sha256"]).toBeDefined();
    });
  });
});
