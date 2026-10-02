/**
 * Phase 5.8: Workstream 5.8.1 — Provider Compliance & Certification Harness Tests
 *
 * Verifies that the certification harness acts as the authoritative arbiter across:
 *   1. Layer A: Semantic Conformance
 *   2. Layer B: Distributed-Systems Conformance
 *   3. Layer C: Security & Provenance Conformance
 *   4. Layer D: Safety & Interlock Conformance
 */

import { describe, it, expect, beforeAll } from "vitest";
import { MockGroundStationProviderAdapter } from "../modules/ground-provider/adapters/mock-provider.adapter";
import { providerCertificationHarness } from "../modules/ground-provider/certification/certification-harness.service";
import { IGroundStationProviderAdapter, DispatchContext, RfRequirements } from "../modules/ground-provider/provider.types";
import { db } from "../db/client";
import { groundStations, groundStationCredentials } from "../db/schema";
import crypto from "crypto";

describe("Phase 5.8: Workstream 5.8.1 — Provider Compliance & Certification Harness", () => {
  let stationId: string;
  let testKeyId: string;
  const testSecretKey = "harness-test-secret-key-32chars!";

  beforeAll(async () => {
    // Seed ground station and credential for harness security checks
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
  });

  // =========================================================================
  // 1. CONFORMING ADAPTER CERTIFICATION
  // =========================================================================
  it("1. Conforming adapter successfully passes all 4 certification layers and receives signed receipt", async () => {
    const conformingAdapter = new MockGroundStationProviderAdapter("certified-mock-provider", {
      supportedBands: ["S_BAND", "X_BAND"],
      maxDataRateMbps: 450,
    });

    const receipt = await providerCertificationHarness.executeFullCertification(conformingAdapter, {
      stationId,
      secretKey: testSecretKey,
      keyId: testKeyId,
    });

    expect(receipt.providerId).toBe("certified-mock-provider");
    expect(receipt.isCertified).toBe(true);
    expect(receipt.summary.semantic).toBe(true);
    expect(receipt.summary.distributed).toBe(true);
    expect(receipt.summary.security).toBe(true);
    expect(receipt.summary.safety).toBe(true);
    expect(receipt.summary.passedAssertions).toBe(receipt.summary.totalAssertions);
    expect(receipt.summary.totalAssertions).toBeGreaterThanOrEqual(14);
    expect(receipt.signature).toBeDefined();
    expect(receipt.signature.length).toBe(64); // SHA-256 hex string

    // Verify all layer details
    expect(receipt.layerResults.SEMANTIC.passed).toBe(true);
    expect(receipt.layerResults.DISTRIBUTED.passed).toBe(true);
    expect(receipt.layerResults.SECURITY.passed).toBe(true);
    expect(receipt.layerResults.SAFETY.passed).toBe(true);
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
});
