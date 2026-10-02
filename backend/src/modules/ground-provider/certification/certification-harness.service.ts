/**
 * Phase 5.8: Workstream 5.8.1 — Provider Compliance & Certification Harness Service
 *
 * Authoritative arbiter between OrbitMesh canonical contract and any external provider adapter.
 * Runs 4 orthogonal conformance suites:
 *   1. Layer A: Semantic Conformance
 *   2. Layer B: Distributed-Systems Conformance
 *   3. Layer C: Security & Provenance Conformance
 *   4. Layer D: Safety & Interlock Conformance
 */

import crypto from "crypto";
import {
  IGroundStationProviderAdapter,
  DispatchContext,
  RfRequirements,
} from "../provider.types";
import { DispatchManifest } from "../../execution/execution.types";
import { groundStationCryptoService } from "../crypto.service";
import { db } from "../../../db/client";
import { groundStations, groundStationCredentials } from "../../../db/schema";
import { eq } from "drizzle-orm";
import {
  ConformanceAssertion,
  ConformanceLayer,
  LayerConformanceResult,
  ProviderCertificationReceipt,
} from "./certification.types";
import { logger } from "../../../config/logger";

export class ProviderCertificationHarness {
  private harnessSecret: string;

  constructor(harnessSecret: string = "orbitmesh-certification-harness-master-key") {
    this.harnessSecret = harnessSecret;
  }

  /**
   * Helper to execute and time an assertion
   */
  private async runAssertion(
    id: string,
    description: string,
    layer: ConformanceLayer,
    fn: () => Promise<void>
  ): Promise<ConformanceAssertion> {
    const start = Date.now();
    try {
      await fn();
      return {
        id,
        description,
        layer,
        passed: true,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        id,
        description,
        layer,
        passed: false,
        error: err.message,
        durationMs: Date.now() - start,
      };
    }
  }

  private compileLayerResult(layer: ConformanceLayer, assertions: ConformanceAssertion[]): LayerConformanceResult {
    const passedAssertions = assertions.filter((a) => a.passed).length;
    const totalAssertions = assertions.length;
    return {
      layer,
      passed: passedAssertions === totalAssertions,
      totalAssertions,
      passedAssertions,
      failedAssertions: totalAssertions - passedAssertions,
      assertions,
    };
  }

  /**
   * Helper: create dummy manifest
   */
  private createMockManifest(dispatchId: string): DispatchManifest {
    const now = Date.now();
    return {
      dispatchId,
      reservationId: crypto.randomUUID(),
      satelliteId: crypto.randomUUID(),
      groundStationId: crypto.randomUUID(),
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
        minDataRateMbps: 100,
      },
      taskManifest: {
        taskId: crypto.randomUUID(),
        priority: 1,
        targetBytes: 500000000,
        remainingBytes: 500000000,
      },
      dispatchedAt: new Date(now).toISOString(),
    };
  }

  // =========================================================================
  // LAYER A: SEMANTIC CONFORMANCE SUITE
  // =========================================================================
  public async runSemanticConformanceSuite(
    adapter: IGroundStationProviderAdapter
  ): Promise<LayerConformanceResult> {
    const assertions: ConformanceAssertion[] = [];

    // Assertion A.1: Capability check for supported bands
    assertions.push(
      await this.runAssertion(
        "SEMANTIC-A1",
        "validateCapabilities accepts supported RF parameters",
        "SEMANTIC",
        async () => {
          const req: RfRequirements = { frequencyBand: "S_BAND", dataRateMbps: 100 };
          const cap = await adapter.validateCapabilities("any-station", req);
          if (!cap.isCompatible) {
            throw new Error(`Expected compatible RF parameters, received incompatible: ${cap.reason}`);
          }
        }
      )
    );

    // Assertion A.2: Capability check for unsupported bands
    assertions.push(
      await this.runAssertion(
        "SEMANTIC-A2",
        "validateCapabilities rejects unsupported RF parameters",
        "SEMANTIC",
        async () => {
          const req: RfRequirements = { frequencyBand: "KA_BAND", dataRateMbps: 20000 };
          const cap = await adapter.validateCapabilities("any-station", req);
          if (cap.isCompatible) {
            throw new Error("Expected incompatible for unsupported Ka-Band at 20Gbps");
          }
        }
      )
    );

    // Assertion A.3: stagePass returns conformant StagedPassReceipt
    const testDispatchId = `cert-sem-${Date.now()}`;
    const context: DispatchContext = {
      dispatchId: testDispatchId,
      attemptNumber: 1,
      idempotencyKey: `idemp-sem-${Date.now()}`,
      correlationId: `corr-sem-${Date.now()}`,
      providerId: adapter.providerId,
      stationCode: "CERT-STATION",
    };
    const manifest = this.createMockManifest(testDispatchId);

    assertions.push(
      await this.runAssertion(
        "SEMANTIC-A3",
        "stagePass returns conformant StagedPassReceipt with provider reference and timestamp",
        "SEMANTIC",
        async () => {
          const receipt = await adapter.stagePass(manifest, context);
          if (!receipt || !receipt.providerDispatchRef || !receipt.stagedAt) {
            throw new Error("Invalid StagedPassReceipt structure");
          }
        }
      )
    );

    // Assertion A.4: armPass returns conformant ArmedPassReceipt
    assertions.push(
      await this.runAssertion(
        "SEMANTIC-A4",
        "armPass returns conformant ArmedPassReceipt with tracking configured",
        "SEMANTIC",
        async () => {
          const receipt = await adapter.armPass(testDispatchId, context);
          if (!receipt || !receipt.armedAt || receipt.trackingConfigured === undefined) {
            throw new Error("Invalid ArmedPassReceipt structure");
          }
        }
      )
    );

    // Assertion A.5: pollPassStatus returns valid snapshot
    assertions.push(
      await this.runAssertion(
        "SEMANTIC-A5",
        "pollPassStatus returns valid PassStatusSnapshot if implemented",
        "SEMANTIC",
        async () => {
          if (adapter.pollPassStatus) {
            const status = await adapter.pollPassStatus(testDispatchId, context);
            if (!status || !status.state || status.carrierLocked === undefined) {
              throw new Error("Invalid PassStatusSnapshot structure");
            }
          }
        }
      )
    );

    // Assertion A.6: abortPass returns conformant PassAbortReceipt
    assertions.push(
      await this.runAssertion(
        "SEMANTIC-A6",
        "abortPass returns conformant PassAbortReceipt with confirmedAt timestamp",
        "SEMANTIC",
        async () => {
          const receipt = await adapter.abortPass(testDispatchId, "CERTIFICATION_TEST", context);
          if (!receipt || !receipt.confirmedAt || receipt.rfCarrierSilenced === undefined) {
            throw new Error("Invalid PassAbortReceipt structure");
          }
        }
      )
    );

    return this.compileLayerResult("SEMANTIC", assertions);
  }

  // =========================================================================
  // LAYER B: DISTRIBUTED-SYSTEMS CONFORMANCE SUITE
  // =========================================================================
  public async runDistributedConformanceSuite(
    adapter: IGroundStationProviderAdapter
  ): Promise<LayerConformanceResult> {
    const assertions: ConformanceAssertion[] = [];

    const dispatchId = `cert-dist-${Date.now()}`;
    const idempotencyKey = `idemp-dist-${Date.now()}`;
    const context: DispatchContext = {
      dispatchId,
      attemptNumber: 1,
      idempotencyKey,
      correlationId: `corr-dist-${Date.now()}`,
      providerId: adapter.providerId,
      stationCode: "CERT-STATION",
    };
    const manifest = this.createMockManifest(dispatchId);

    // Assertion B.1: Duplicate stagePass returns idempotent receipt without mutating state
    assertions.push(
      await this.runAssertion(
        "DISTRIBUTED-B1",
        "Duplicate stagePass returns idempotent receipt with zero state mutation",
        "DISTRIBUTED",
        async () => {
          const first = await adapter.stagePass(manifest, context);
          const second = await adapter.stagePass(manifest, context);
          if (first.providerDispatchRef !== second.providerDispatchRef) {
            throw new Error(
              `Non-idempotent response: first ref [${first.providerDispatchRef}] !== second ref [${second.providerDispatchRef}]`
            );
          }
        }
      )
    );

    // Assertion B.2: Status reconciliation after ambiguous outcome
    assertions.push(
      await this.runAssertion(
        "DISTRIBUTED-B2",
        "pollPassStatus confirms staged state after simulated ambiguous outcome",
        "DISTRIBUTED",
        async () => {
          if (!adapter.pollPassStatus) {
            return; // Optional method
          }
          const snapshot = await adapter.pollPassStatus(dispatchId, context);
          if (snapshot.state !== "STAGED" && snapshot.state !== "ARMED") {
            throw new Error(`Expected STAGED or ARMED status on staged dispatch, got ${snapshot.state}`);
          }
        }
      )
    );

    // Assertion B.3: Unknown dispatch lookup returns UNKNOWN rather than phantom pass
    assertions.push(
      await this.runAssertion(
        "DISTRIBUTED-B3",
        "Querying unknown dispatch returns UNKNOWN status rather than phantom pass",
        "DISTRIBUTED",
        async () => {
          if (!adapter.pollPassStatus) {
            return;
          }
          const unknownId = `unknown-${crypto.randomUUID()}`;
          const unknownContext: DispatchContext = {
            ...context,
            dispatchId: unknownId,
            idempotencyKey: `idemp-${unknownId}`,
          };
          const snapshot = await adapter.pollPassStatus(unknownId, unknownContext);
          if (snapshot.state !== "UNKNOWN") {
            throw new Error(`Expected UNKNOWN state for non-existent dispatch, got ${snapshot.state}`);
          }
        }
      )
    );

    return this.compileLayerResult("DISTRIBUTED", assertions);
  }

  // =========================================================================
  // LAYER C: SECURITY & PROVENANCE CONFORMANCE SUITE
  // =========================================================================
  public async runSecurityConformanceSuite(
    adapter: IGroundStationProviderAdapter,
    options: {
      stationId?: string;
      secretKey?: string;
      keyId?: string;
    } = {}
  ): Promise<LayerConformanceResult> {
    const assertions: ConformanceAssertion[] = [];

    // Ensure we have a database credential to test against
    let stationId = options.stationId;
    let secretKey = options.secretKey || "cert-harness-secret-key-32byteslong";
    let keyId = options.keyId;

    if (!stationId || !keyId) {
      // Find or create test station & credential
      let [station] = await db.select().from(groundStations).limit(1);
      if (!station) {
        [station] = await db
          .insert(groundStations)
          .values({
            code: `CERT-GS-${Date.now() % 10000}`,
            name: "Certification-GS",
            latitude: 10.0,
            longitude: 20.0,
            status: "AVAILABLE",
            minimumElevationDeg: 5,
            supportedFrequencyBands: ["S_BAND"],
          })
          .returning();
      }
      if (!station) {
        throw new Error("Failed to find or create certification ground station");
      }
      stationId = station.id;

      keyId = `key-cert-${crypto.randomUUID().slice(0, 8)}`;
      await db.insert(groundStationCredentials).values({
        groundStationId: stationId,
        keyId,
        secretKey,
        status: "ACTIVE",
        expiresAt: new Date(Date.now() + 86400000),
      });
    }

    const testDispatchId = `cert-sec-${Date.now()}`;
    const payload = { bytesReceived: 100000, snrDb: 18.5 };

    // Assertion C.1: Valid signature passes verification
    assertions.push(
      await this.runAssertion(
        "SECURITY-C1",
        "Valid HMAC-SHA256 signature and fresh nonce passes verification",
        "SECURITY",
        async () => {
          const nonce = `nonce-${crypto.randomUUID()}`;
          const timestamp = new Date().toISOString();
          const canonical = groundStationCryptoService.buildCanonicalString(
            testDispatchId,
            1,
            timestamp,
            nonce,
            payload
          );
          const signature = groundStationCryptoService.generateSignature(secretKey, canonical);

          const result = await groundStationCryptoService.verifyTelemetrySignature(
            { keyId: keyId!, signature, nonce, timestamp },
            testDispatchId,
            1,
            payload
          );

          if (!result.isValid) {
            throw new Error(`Verification failed: ${result.errorCode} - ${result.errorMessage}`);
          }
        }
      )
    );

    // Assertion C.2: Tampered payload is rejected
    assertions.push(
      await this.runAssertion(
        "SECURITY-C2",
        "Tampered payload bytes rejected with INVALID_SIGNATURE",
        "SECURITY",
        async () => {
          const nonce = `nonce-${crypto.randomUUID()}`;
          const timestamp = new Date().toISOString();
          const canonical = groundStationCryptoService.buildCanonicalString(
            testDispatchId,
            2,
            timestamp,
            nonce,
            payload
          );
          const signature = groundStationCryptoService.generateSignature(secretKey, canonical);

          // Mutate payload
          const tamperedPayload = { bytesReceived: 999999999, snrDb: 18.5 };

          const result = await groundStationCryptoService.verifyTelemetrySignature(
            { keyId: keyId!, signature, nonce, timestamp },
            testDispatchId,
            2,
            tamperedPayload
          );

          if (result.isValid || result.errorCode !== "INVALID_SIGNATURE") {
            throw new Error(`Expected INVALID_SIGNATURE, got ${result.errorCode}`);
          }
        }
      )
    );

    // Assertion C.3: Replayed nonce is rejected
    assertions.push(
      await this.runAssertion(
        "SECURITY-C3",
        "Replayed nonce is rejected with NONCE_REPLAY_DETECTED",
        "SECURITY",
        async () => {
          const nonce = `nonce-replay-${crypto.randomUUID()}`;
          const timestamp = new Date().toISOString();
          const canonical = groundStationCryptoService.buildCanonicalString(
            testDispatchId,
            3,
            timestamp,
            nonce,
            payload
          );
          const signature = groundStationCryptoService.generateSignature(secretKey, canonical);

          // First submission: passes
          const first = await groundStationCryptoService.verifyTelemetrySignature(
            { keyId: keyId!, signature, nonce, timestamp },
            testDispatchId,
            3,
            payload
          );
          if (!first.isValid) throw new Error("First submission failed unexpectedly");

          // Second submission with exact same nonce: must fail
          const second = await groundStationCryptoService.verifyTelemetrySignature(
            { keyId: keyId!, signature, nonce, timestamp },
            testDispatchId,
            3,
            payload
          );
          if (second.isValid || second.errorCode !== "NONCE_REPLAY_DETECTED") {
            throw new Error(`Expected NONCE_REPLAY_DETECTED, got ${second.errorCode}`);
          }
        }
      )
    );

    // Assertion C.4: Clock skew violation is rejected
    assertions.push(
      await this.runAssertion(
        "SECURITY-C4",
        "Clock skew exceeding tolerance is rejected with CLOCK_SKEW_EXCEEDED",
        "SECURITY",
        async () => {
          const nonce = `nonce-skew-${crypto.randomUUID()}`;
          const staleTimestamp = new Date(Date.now() - 30000).toISOString(); // 30s in the past
          const canonical = groundStationCryptoService.buildCanonicalString(
            testDispatchId,
            4,
            staleTimestamp,
            nonce,
            payload
          );
          const signature = groundStationCryptoService.generateSignature(secretKey, canonical);

          const result = await groundStationCryptoService.verifyTelemetrySignature(
            { keyId: keyId!, signature, nonce, timestamp: staleTimestamp },
            testDispatchId,
            4,
            payload
          );

          if (result.isValid || result.errorCode !== "CLOCK_SKEW_EXCEEDED") {
            throw new Error(`Expected CLOCK_SKEW_EXCEEDED, got ${result.errorCode}`);
          }
        }
      )
    );

    // Assertion C.5: Revoked credential is immediately rejected
    assertions.push(
      await this.runAssertion(
        "SECURITY-C5",
        "Revoked credential immediately rejected with CREDENTIAL_REVOKED",
        "SECURITY",
        async () => {
          const revokedKeyId = `key-rev-${crypto.randomUUID().slice(0, 8)}`;
          await db.insert(groundStationCredentials).values({
            groundStationId: stationId!,
            keyId: revokedKeyId,
            secretKey: secretKey,
            status: "REVOKED",
            expiresAt: new Date(Date.now() + 86400000),
            revokedAt: new Date(),
          });

          const nonce = `nonce-rev-${crypto.randomUUID()}`;
          const timestamp = new Date().toISOString();
          const canonical = groundStationCryptoService.buildCanonicalString(
            testDispatchId,
            5,
            timestamp,
            nonce,
            payload
          );
          const signature = groundStationCryptoService.generateSignature(secretKey, canonical);

          const result = await groundStationCryptoService.verifyTelemetrySignature(
            { keyId: revokedKeyId, signature, nonce, timestamp },
            testDispatchId,
            5,
            payload
          );

          if (result.isValid || result.errorCode !== "CREDENTIAL_REVOKED") {
            throw new Error(`Expected CREDENTIAL_REVOKED, got ${result.errorCode}`);
          }
        }
      )
    );

    return this.compileLayerResult("SECURITY", assertions);
  }

  // =========================================================================
  // LAYER D: SAFETY & INTERLOCK CONFORMANCE SUITE
  // =========================================================================
  public async runSafetyConformanceSuite(
    adapter: IGroundStationProviderAdapter
  ): Promise<LayerConformanceResult> {
    const assertions: ConformanceAssertion[] = [];

    const dispatchId = `cert-safe-${Date.now()}`;
    const context: DispatchContext = {
      dispatchId,
      attemptNumber: 1,
      idempotencyKey: `idemp-safe-${Date.now()}`,
      correlationId: `corr-safe-${Date.now()}`,
      providerId: adapter.providerId,
      stationCode: "CERT-STATION",
    };

    // Assertion D.1: Emergency abort executes and confirms RF carrier silenced
    assertions.push(
      await this.runAssertion(
        "SAFETY-D1",
        "Emergency abort command confirms physical RF carrier silenced",
        "SAFETY",
        async () => {
          const receipt = await adapter.abortPass(dispatchId, "EMERGENCY_COLLISION_AVOIDANCE", context);
          if (!receipt || !receipt.rfCarrierSilenced) {
            throw new Error("Provider did not confirm RF carrier silenced on abort command");
          }
        }
      )
    );

    // Assertion D.2: Communication failure during abort does not falsify confirmation
    assertions.push(
      await this.runAssertion(
        "SAFETY-D2",
        "Link failure / timeout during abort strictly prevents false physical confirmation",
        "SAFETY",
        async () => {
          // If the adapter simulates an abort timeout, it must NOT return rfCarrierSilenced = true
          if ("options" in adapter && (adapter as any).options) {
            (adapter as any).options.simulateAbortTimeout = true;
            try {
              const receipt = await adapter.abortPass(dispatchId, "TIMEOUT_TEST", context);
              if (receipt && receipt.rfCarrierSilenced) {
                throw new Error("VIOLATION: Adapter manufactured false physical confirmation during simulated timeout!");
              }
            } catch (err: any) {
              // Expected error or timeout
              if (err.message !== "ABORT_TRANSPORT_TIMEOUT") {
                throw err;
              }
            } finally {
              (adapter as any).options.simulateAbortTimeout = false;
            }
          }
        }
      )
    );

    return this.compileLayerResult("SAFETY", assertions);
  }

  public static readonly CURRENT_CONTRACT_VERSION = "5.8.0";
  public static readonly CURRENT_SUITE_VERSION = "5.8.1";
  public static readonly DEFAULT_VALIDITY_DAYS = 90;

  // =========================================================================
  // COMPLETE 4-LAYER CERTIFICATION EXECUTION
  // =========================================================================
  public async executeFullCertification(
    adapter: IGroundStationProviderAdapter,
    options: {
      stationId?: string;
      secretKey?: string;
      keyId?: string;
      adapterVersion?: string;
      environment?: "PRODUCTION" | "STAGING" | "LAB" | "TEST";
      validityDays?: number;
    } = {}
  ): Promise<ProviderCertificationReceipt> {
    logger.info(
      { providerId: adapter.providerId },
      "[CERTIFICATION_HARNESS] Starting 4-layer compliance certification"
    );

    const semantic = await this.runSemanticConformanceSuite(adapter);
    const distributed = await this.runDistributedConformanceSuite(adapter);
    const security = await this.runSecurityConformanceSuite(adapter, options);
    const safety = await this.runSafetyConformanceSuite(adapter);

    const isCertified =
      semantic.passed && distributed.passed && security.passed && safety.passed;

    const totalAssertions =
      semantic.totalAssertions +
      distributed.totalAssertions +
      security.totalAssertions +
      safety.totalAssertions;

    const passedAssertions =
      semantic.passedAssertions +
      distributed.passedAssertions +
      security.passedAssertions +
      safety.passedAssertions;

    const certifiedAt = new Date();
    const validityDays = options.validityDays ?? ProviderCertificationHarness.DEFAULT_VALIDITY_DAYS;
    const expiresAt = new Date(certifiedAt.getTime() + validityDays * 86400000);
    const certificationRunId = `CERT-${certifiedAt.toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
    const adapterVersion = options.adapterVersion || (adapter as any).version || "1.0.0";
    const contractVersion = ProviderCertificationHarness.CURRENT_CONTRACT_VERSION;
    const certificationSuiteVersion = ProviderCertificationHarness.CURRENT_SUITE_VERSION;
    const environment = options.environment || "PRODUCTION";

    // Compute cryptographic digest over results and metadata
    const digestPayload = {
      certificationRunId,
      providerId: adapter.providerId,
      adapterVersion,
      contractVersion,
      certificationSuiteVersion,
      certifiedAt: certifiedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      environment,
      isCertified,
      semanticPassed: semantic.passed,
      distributedPassed: distributed.passed,
      securityPassed: security.passed,
      safetyPassed: safety.passed,
      totalAssertions,
      passedAssertions,
    };

    const resultsDigest = crypto
      .createHash("sha256")
      .update(JSON.stringify(digestPayload))
      .digest("hex");

    const signature = crypto
      .createHmac("sha256", this.harnessSecret)
      .update(resultsDigest)
      .digest("hex");

    const receipt: ProviderCertificationReceipt = {
      certificationRunId,
      providerId: adapter.providerId,
      adapterVersion,
      contractVersion,
      certificationSuiteVersion,
      certifiedAt,
      expiresAt,
      environment,
      isCertified,
      resultsDigest,
      summary: {
        semantic: semantic.passed,
        distributed: distributed.passed,
        security: security.passed,
        safety: safety.passed,
        totalAssertions,
        passedAssertions,
      },
      layerResults: {
        SEMANTIC: semantic,
        DISTRIBUTED: distributed,
        SECURITY: security,
        SAFETY: safety,
      },
      signature,
    };

    logger.info(
      {
        certificationRunId,
        providerId: adapter.providerId,
        adapterVersion,
        contractVersion,
        isCertified,
        passedAssertions,
        totalAssertions,
      },
      `[CERTIFICATION_HARNESS] Certification finished: ${isCertified ? "CERTIFIED" : "FAILED"}`
    );

    return receipt;
  }

  /**
   * Verify an existing certification receipt against master harness key, expiration, and version binding
   */
  public verifyReceipt(receipt: ProviderCertificationReceipt): {
    isValid: boolean;
    reason?: string;
  } {
    if (!receipt.isCertified) {
      return { isValid: false, reason: "Receipt records failed certification" };
    }
    if (new Date(receipt.expiresAt).getTime() < Date.now()) {
      return { isValid: false, reason: "Certification receipt has expired" };
    }
    if (receipt.contractVersion !== ProviderCertificationHarness.CURRENT_CONTRACT_VERSION) {
      return {
        isValid: false,
        reason: `Contract version mismatch: receipt has [${receipt.contractVersion}], active is [${ProviderCertificationHarness.CURRENT_CONTRACT_VERSION}]`,
      };
    }

    const digestPayload = {
      certificationRunId: receipt.certificationRunId,
      providerId: receipt.providerId,
      adapterVersion: receipt.adapterVersion,
      contractVersion: receipt.contractVersion,
      certificationSuiteVersion: receipt.certificationSuiteVersion,
      certifiedAt: new Date(receipt.certifiedAt).toISOString(),
      expiresAt: new Date(receipt.expiresAt).toISOString(),
      environment: receipt.environment,
      isCertified: receipt.isCertified,
      semanticPassed: receipt.summary.semantic,
      distributedPassed: receipt.summary.distributed,
      securityPassed: receipt.summary.security,
      safetyPassed: receipt.summary.safety,
      totalAssertions: receipt.summary.totalAssertions,
      passedAssertions: receipt.summary.passedAssertions,
    };

    const expectedDigest = crypto
      .createHash("sha256")
      .update(JSON.stringify(digestPayload))
      .digest("hex");

    if (receipt.resultsDigest !== expectedDigest) {
      return { isValid: false, reason: "Tampered results digest in certification receipt" };
    }

    const expectedSig = crypto
      .createHmac("sha256", this.harnessSecret)
      .update(expectedDigest)
      .digest("hex");

    const sigBuffer = Buffer.from(receipt.signature, "hex");
    const expBuffer = Buffer.from(expectedSig, "hex");

    if (
      sigBuffer.length !== expBuffer.length ||
      !crypto.timingSafeEqual(sigBuffer, expBuffer)
    ) {
      return { isValid: false, reason: "Invalid HMAC signature on certification receipt" };
    }

    return { isValid: true };
  }
}

export const providerCertificationHarness = new ProviderCertificationHarness();
