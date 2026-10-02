/**
 * Phase 5.8: Workstream 5.8.1 — Provider Compliance & Certification Harness Tests
 *
 * Verifies that the certification harness acts as the authoritative arbiter across:
 *   1. Layer A: Semantic Conformance
 *   2. Layer B: Distributed-Systems Conformance
 *   3. Layer C: Security & Provenance Conformance
 *   4. Layer D: Safety & Interlock Conformance
 *   5. Production Dispatch Gate & Version-Bound Enforcement
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MockGroundStationProviderAdapter } from "../modules/ground-provider/adapters/mock-provider.adapter";
import { providerCertificationHarness } from "../modules/ground-provider/certification/certification-harness.service";
import { IGroundStationProviderAdapter, DispatchContext, RfRequirements } from "../modules/ground-provider/provider.types";
import {
  providerRegistry,
  ProviderNotCertifiedError,
} from "../modules/ground-provider/provider.registry";
import { outboxService } from "../modules/outbox/outbox.service";
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
import { eq, inArray } from "drizzle-orm";
import crypto from "crypto";

describe("Phase 5.8: Workstream 5.8.1 — Provider Compliance & Certification Harness", () => {
  let stationId: string;
  let satId: string;
  let odId: string;
  let testKeyId: string;
  const testSecretKey = "harness-test-secret-key-32chars!";

  const epochBase = Date.now() + 100000000;
  let contactCounter = 0;

  beforeAll(async () => {
    // 1. Seed ground station and credential for harness security checks
    const [gs] = await db
      .insert(groundStations)
      .values({
        code: `CERT-HARNESS-${Date.now() % 10000}`,
        name: "Harness-Station",
        latitude: 25.0,
        longitude: 55.0,
        altitudeM: 50,
        status: "AVAILABLE",
        minimumElevationDeg: 5,
        supportedFrequencyBands: ["S_BAND", "X_BAND"],
        maxConcurrentContacts: 2,
        maxDataRateMbps: 300,
      })
      .returning();
    stationId = gs.id;

    testKeyId = `key-harness-${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(groundStationCredentials).values({
      groundStationId: stationId,
      keyId: testKeyId,
      secretKey: testSecretKey,
      status: "ACTIVE",
      expiresAt: new Date(Date.now() + 86400000),
    });

    // 2. Setup base satellite and orbital data for reservation tests
    const [sat] = await db
      .insert(satellites)
      .values({
        noradId: 67301,
        name: "Cert-Sat-1",
        status: "ACTIVE",
      })
      .returning();
    satId = sat.id;

    const [od] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: satId,
        source: "CELESTRAK",
        tleLine1: "1 67301U 26001A   26270.00000000  .00001000  00000-0  10000-3 0  9991",
        tleLine2: "2 67301  97.5000 120.0000 0010000  45.0000 315.0000 15.10000000000018",
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

  async function seedTestReservation(suffix: string) {
    contactCounter++;
    const startMs = epochBase + contactCounter * 3600000;
    const endMs = startMs + 600000;

    const [task] = await db
      .insert(missionTasks)
      .values({
        satelliteId: satId,
        name: `Task-5.8-${suffix}-${contactCounter}`,
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

  // =========================================================================
  // 1. CONFORMING ADAPTER CERTIFICATION
  // =========================================================================
  it("1. Conforming adapter successfully passes all 4 certification layers and receives signed receipt with version binding", async () => {
    const conformingAdapter = new MockGroundStationProviderAdapter("certified-mock-provider", {
      supportedBands: ["S_BAND", "X_BAND"],
      maxDataRateMbps: 450,
    });

    const receipt = await providerCertificationHarness.executeFullCertification(conformingAdapter, {
      stationId,
      secretKey: testSecretKey,
      keyId: testKeyId,
      adapterVersion: "1.0.0",
      environment: "PRODUCTION",
    });

    expect(receipt.providerId).toBe("certified-mock-provider");
    expect(receipt.isCertified).toBe(true);
    expect(receipt.adapterVersion).toBe("1.0.0");
    expect(receipt.contractVersion).toBe("5.8.0");
    expect(receipt.certificationSuiteVersion).toBe("5.8.1");
    expect(receipt.certificationRunId).toMatch(/^CERT-\d{8}-[a-f0-9]{8}$/);
    expect(receipt.resultsDigest).toBeDefined();
    expect(receipt.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(receipt.summary.semantic).toBe(true);
    expect(receipt.summary.distributed).toBe(true);
    expect(receipt.summary.security).toBe(true);
    expect(receipt.summary.safety).toBe(true);
    expect(receipt.summary.passedAssertions).toBe(receipt.summary.totalAssertions);
    expect(receipt.summary.totalAssertions).toBeGreaterThanOrEqual(16);
    expect(receipt.signature).toBeDefined();
    expect(receipt.signature.length).toBe(64); // SHA-256 hex string

    // Verify all 4 layer assertion structures are fully preserved
    expect(receipt.layerResults.SEMANTIC.passed).toBe(true);
    expect(receipt.layerResults.SEMANTIC.assertions.length).toBeGreaterThanOrEqual(6);
    expect(receipt.layerResults.DISTRIBUTED.passed).toBe(true);
    expect(receipt.layerResults.SECURITY.passed).toBe(true);
    expect(receipt.layerResults.SAFETY.passed).toBe(true);

    // Verify cryptographic receipt verification
    const verification = providerCertificationHarness.verifyReceipt(receipt);
    expect(verification.isValid).toBe(true);
  });

  // =========================================================================
  // 2. LAYER A: SEMANTIC NON-CONFORMANCE DETECTION
  // =========================================================================
  it("2. Harness detects semantic non-conformance when adapter violates capability validation", async () => {
    const nonConformingAdapter: IGroundStationProviderAdapter = {
      providerId: "broken-semantic-provider",
      validateCapabilities: async () => {
        // Violates contract: always claims compatible even for 20Gbps Ka-Band
        return { isCompatible: true, unsupportedBands: [], maxDataRateFeasible: true };
      },
      stagePass: async () => {
        throw new Error("Not implemented");
      },
      armPass: async () => {
        throw new Error("Not implemented");
      },
      abortPass: async () => {
        throw new Error("Not implemented");
      },
    };

    const layerResult = await providerCertificationHarness.runSemanticConformanceSuite(nonConformingAdapter);

    expect(layerResult.passed).toBe(false);
    expect(layerResult.failedAssertions).toBeGreaterThan(0);
    const failedAssertion = layerResult.assertions.find((a) => a.id === "SEMANTIC-A2");
    expect(failedAssertion).toBeDefined();
    expect(failedAssertion!.passed).toBe(false);
    expect(failedAssertion!.error).toContain("Expected incompatible for unsupported Ka-Band");
  });

  // =========================================================================
  // 3. LAYER B: DISTRIBUTED-SYSTEMS NON-CONFORMANCE DETECTION
  // =========================================================================
  it("3. Harness detects distributed non-conformance when adapter violates idempotency", async () => {
    let callCount = 0;
    const nonIdempotentAdapter: IGroundStationProviderAdapter = {
      providerId: "non-idempotent-provider",
      validateCapabilities: async () => ({
        isCompatible: true,
        unsupportedBands: [],
        maxDataRateFeasible: true,
      }),
      stagePass: async () => {
        callCount++;
        // Violates idempotency: returns a different reference on duplicate call
        return {
          providerDispatchRef: `ref-mutated-${callCount}`,
          stagedAt: new Date(),
          stationStatus: "READY",
          rawProviderResponse: {},
        };
      },
      armPass: async () => ({
        armedAt: new Date(),
        trackingConfigured: true,
        rawProviderResponse: {},
      }),
      abortPass: async () => ({
        confirmedAt: new Date(),
        rfCarrierSilenced: true,
        rawProviderResponse: {},
      }),
    };

    const layerResult = await providerCertificationHarness.runDistributedConformanceSuite(nonIdempotentAdapter);

    expect(layerResult.passed).toBe(false);
    const idempAssertion = layerResult.assertions.find((a) => a.id === "DISTRIBUTED-B1");
    expect(idempAssertion).toBeDefined();
    expect(idempAssertion!.passed).toBe(false);
    expect(idempAssertion!.error).toContain("Non-idempotent response");
  });

  // =========================================================================
  // 4. LAYER C: SECURITY CONFORMANCE ASSERTIONS
  // =========================================================================
  it("4. Harness evaluates security conformance: passes valid HMAC, rejects tampered payloads and replayed nonces", async () => {
    const adapter = new MockGroundStationProviderAdapter("security-target-provider");

    const layerResult = await providerCertificationHarness.runSecurityConformanceSuite(adapter, {
      stationId,
      secretKey: testSecretKey,
      keyId: testKeyId,
    });

    expect(layerResult.passed).toBe(true);
    expect(layerResult.totalAssertions).toBe(5);
    expect(layerResult.passedAssertions).toBe(5);

    // Verify all security assertions are present
    const assertionIds = layerResult.assertions.map((a) => a.id);
    expect(assertionIds).toContain("SECURITY-C1"); // Valid signature
    expect(assertionIds).toContain("SECURITY-C2"); // Tampered payload
    expect(assertionIds).toContain("SECURITY-C3"); // Replayed nonce
    expect(assertionIds).toContain("SECURITY-C4"); // Clock skew
    expect(assertionIds).toContain("SECURITY-C5"); // Revoked credential
  });

  // =========================================================================
  // 5. LAYER D: SAFETY CONFORMANCE ASSERTIONS
  // =========================================================================
  it("5. Harness evaluates safety conformance: asserts RF carrier silenced, rejects false physical confirmations", async () => {
    const adapter = new MockGroundStationProviderAdapter("safety-target-provider");

    const layerResult = await providerCertificationHarness.runSafetyConformanceSuite(adapter);

    expect(layerResult.passed).toBe(true);
    expect(layerResult.totalAssertions).toBe(2);
    expect(layerResult.passedAssertions).toBe(2);

    const abortAssertion = layerResult.assertions.find((a) => a.id === "SAFETY-D1");
    expect(abortAssertion?.passed).toBe(true);

    const ambiguityAssertion = layerResult.assertions.find((a) => a.id === "SAFETY-D2");
    expect(ambiguityAssertion?.passed).toBe(true);
  });

  // =========================================================================
  // 6. PRODUCTION CERTIFICATION GATE ENFORCEMENT
  // =========================================================================
  it("6. Production Dispatch Gate: uncertified provider is rejected at production dispatch boundary", async () => {
    const uncertifiedAdapter = new MockGroundStationProviderAdapter("unauthorized-rogue-provider");
    // Register without certification receipt
    providerRegistry.registerAdapter(uncertifiedAdapter);

    expect(providerRegistry.isCertified("unauthorized-rogue-provider")).toBe(false);

    // Assert that assertCertified throws ProviderNotCertifiedError
    expect(() => {
      providerRegistry.assertCertified("unauthorized-rogue-provider");
    }).toThrow(ProviderNotCertifiedError);

    // Seed reservation to attempt production dispatch
    const { res } = await seedTestReservation("UncertifiedGate");

    // Attempting production dispatch to uncertified provider must be rejected!
    await expect(
      outboxService.transitionToExecutionReadyWithOutbox(
        res.id,
        "unauthorized-rogue-provider"
      )
    ).rejects.toThrow(ProviderNotCertifiedError);

    // Verify reservation was NOT mutated to EXECUTION_READY
    const [checkRes] = await db.select().from(reservations).where(eq(reservations.id, res.id));
    expect(checkRes.executionState).toBe("SCHEDULED");
  });

  // =========================================================================
  // 7. CERTIFICATION ADMISSION UNLOCKS PRODUCTION DISPATCH
  // =========================================================================
  it("7. Certification Admission: provider passing 4-layer harness is admitted and unlocked for production dispatch", async () => {
    const newProvider = new MockGroundStationProviderAdapter("candidate-provider-v1", {
      supportedBands: ["S_BAND", "X_BAND"],
      maxDataRateMbps: 300,
    });
    providerRegistry.registerAdapter(newProvider); // starts uncertified

    // 1. Run 4-layer certification harness
    const receipt = await providerCertificationHarness.executeFullCertification(newProvider, {
      stationId,
      secretKey: testSecretKey,
      keyId: testKeyId,
      adapterVersion: "1.0.0",
    });
    expect(receipt.isCertified).toBe(true);

    // 2. Authoritatively ingest receipt into registry
    providerRegistry.certifyAdapter("candidate-provider-v1", receipt);
    expect(providerRegistry.isCertified("candidate-provider-v1")).toBe(true);

    // 3. Production dispatch now succeeds cleanly!
    const { res } = await seedTestReservation("AdmittedDispatch");
    const dispatchResult = await outboxService.transitionToExecutionReadyWithOutbox(
      res.id,
      "candidate-provider-v1"
    );

    expect(dispatchResult.dispatchId).toBeDefined();
    const [checkRes] = await db.select().from(reservations).where(eq(reservations.id, res.id));
    expect(checkRes.executionState).toBe("EXECUTION_READY");
  });

  // =========================================================================
  // 8. REJECTION OF TAMPERED OR EXPIRED CERTIFICATION RECEIPTS
  // =========================================================================
  it("8. Rejection of tampered, expired, or version-mismatched certification receipts", async () => {
    const targetProvider = new MockGroundStationProviderAdapter("strict-audit-provider");
    providerRegistry.registerAdapter(targetProvider);

    const validReceipt = await providerCertificationHarness.executeFullCertification(targetProvider, {
      stationId,
      secretKey: testSecretKey,
      keyId: testKeyId,
    });

    // 1. Tampered results digest: must be rejected
    const tamperedReceipt = {
      ...validReceipt,
      resultsDigest: "0000000000000000000000000000000000000000000000000000000000000000",
    };
    expect(() => {
      providerRegistry.certifyAdapter("strict-audit-provider", tamperedReceipt);
    }).toThrow(ProviderNotCertifiedError);

    // 2. Expired receipt: must be rejected
    const expiredReceipt = {
      ...validReceipt,
      expiresAt: new Date(Date.now() - 10000), // 10s ago
    };
    expect(() => {
      providerRegistry.certifyAdapter("strict-audit-provider", expiredReceipt);
    }).toThrow(ProviderNotCertifiedError);

    // 3. Contract version mismatch: must be rejected
    const mismatchedReceipt = {
      ...validReceipt,
      contractVersion: "4.0.0", // obsolete contract
    };
    expect(() => {
      providerRegistry.certifyAdapter("strict-audit-provider", mismatchedReceipt);
    }).toThrow(ProviderNotCertifiedError);
  });
});
