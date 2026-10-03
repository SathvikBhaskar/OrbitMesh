/**
 * Phase 5.8: Workstream 5.8.3 — Production Transport Security & Key Custody
 * Secure Abort Channel: Out-of-band Authenticated Emergency Abort Protocol
 */

import crypto from "crypto";
import { logger } from "../../../config/logger";
import { safetyInterlockService, SafetyInterlockService } from "../safety-interlock.service";
import { DispatchContext } from "../provider.types";

export interface AuthorizedSafetyOfficer {
  readonly officerId: string;
  readonly role: "SAFETY_OFFICER" | "FLIGHT_DIRECTOR";
  readonly secretKey: string;
  readonly active: boolean;
}

export interface SecureAbortDirective {
  readonly directiveId: string;
  readonly dispatchId: string;
  readonly reservationId: string;
  readonly satelliteId: string;
  readonly stationCode: string;
  readonly emergencyReason: "COLLISION_AVOIDANCE" | "REGULATORY_INHIBIT" | "HARDWARE_ANOMALY" | "UNAUTHORIZED_TRANSMISSION";
  readonly immediateRfInhibit: boolean;
  readonly sequenceCounter: number;
  readonly issuedAt: string; // ISO UTC
  readonly authorizedBy: {
    readonly officerId: string;
    readonly role: "SAFETY_OFFICER" | "FLIGHT_DIRECTOR";
  };
  readonly signature: string; // HMAC-SHA256 signature over canonical directive payload
}

export interface SecureAbortExecutionReceipt {
  readonly receiptId: string;
  readonly directiveId: string;
  readonly dispatchId: string;
  readonly reservationId: string;
  readonly emergencyReason: string;
  readonly carrierSilenced: boolean;
  readonly executedAt: Date;
  readonly latencyMs: number;
  readonly officerId: string;
  readonly executionProof: string;
}

export class SecureAbortChannelService {
  public static readonly MAX_TIMESTAMP_TOLERANCE_MS = 2000; // ±2 seconds
  private readonly authorizedOfficers = new Map<string, AuthorizedSafetyOfficer>();
  private readonly lastSeenSequence = new Map<string, number>(); // dispatchId -> sequenceCounter
  private readonly interlockService: SafetyInterlockService;

  constructor(interlockService = safetyInterlockService) {
    this.interlockService = interlockService;
  }

  /**
   * Register an authorized safety officer credential
   */
  public registerSafetyOfficer(officer: AuthorizedSafetyOfficer): void {
    this.authorizedOfficers.set(officer.officerId, officer);
  }

  /**
   * Canonical string for abort directive signature
   */
  public buildDirectiveCanonicalString(directive: Omit<SecureAbortDirective, "signature">): string {
    return [
      directive.directiveId,
      directive.dispatchId,
      directive.reservationId,
      directive.satelliteId,
      directive.stationCode,
      directive.emergencyReason,
      directive.immediateRfInhibit ? "1" : "0",
      directive.sequenceCounter.toString(),
      directive.issuedAt,
      directive.authorizedBy.officerId,
      directive.authorizedBy.role,
    ].join("|");
  }

  /**
   * Helper to sign an abort directive (used by Flight Director / Safety Officer console)
   */
  public signDirective(directive: Omit<SecureAbortDirective, "signature">, secretKey: string): string {
    const canonical = this.buildDirectiveCanonicalString(directive);
    return crypto.createHmac("sha256", secretKey).update(canonical).digest("hex");
  }

  /**
   * Process incoming Secure Abort Directive over the prioritized out-of-band channel
   */
  async processAbortDirective(
    directive: SecureAbortDirective,
    context: DispatchContext
  ): Promise<SecureAbortExecutionReceipt> {
    const startTime = Date.now();
    const { officerId, role } = directive.authorizedBy;

    // 1. Authenticate Safety Officer Identity
    const officer = this.authorizedOfficers.get(officerId);
    if (!officer) {
      throw new Error(`Unauthorized abort attempt: officer [${officerId}] not registered`);
    }
    if (!officer.active) {
      throw new Error(`Unauthorized abort attempt: officer [${officerId}] credentials inactive`);
    }
    if (officer.role !== role) {
      throw new Error(`Role mismatch: officer [${officerId}] expected [${officer.role}] but got [${role}]`);
    }

    // 2. Clock Skew / Freshness Check (tight 2-second tolerance)
    const issuedTime = new Date(directive.issuedAt).getTime();
    if (isNaN(issuedTime) || Math.abs(issuedTime - startTime) > SecureAbortChannelService.MAX_TIMESTAMP_TOLERANCE_MS) {
      throw new Error(
        `Abort directive timestamp outside narrow tolerance window (allowed: ±${SecureAbortChannelService.MAX_TIMESTAMP_TOLERANCE_MS}ms)`
      );
    }

    // 3. Monotonic Sequence Counter (Anti-Replay)
    const lastSeq = this.lastSeenSequence.get(directive.dispatchId) ?? 0;
    if (directive.sequenceCounter <= lastSeq) {
      throw new Error(
        `Stale or replayed abort directive: sequenceCounter [${directive.sequenceCounter}] must be > [${lastSeq}]`
      );
    }

    // 4. Cryptographic Signature Verification
    const canonical = this.buildDirectiveCanonicalString(directive);
    const expectedSig = crypto.createHmac("sha256", officer.secretKey).update(canonical).digest("hex");

    const sigBuf = Buffer.from(directive.signature, "hex");
    const expBuf = Buffer.from(expectedSig, "hex");
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new Error("Invalid cryptographic signature on emergency abort directive");
    }

    // Update sequence counter
    this.lastSeenSequence.set(directive.dispatchId, directive.sequenceCounter);

    logger.warn(
      {
        directiveId: directive.directiveId,
        dispatchId: directive.dispatchId,
        officerId,
        reason: directive.emergencyReason,
      },
      "[SECURE_ABORT] Verified authentic emergency abort directive. Triggering immediate carrier silence."
    );

    // 5. Execute Emergency Abort via Safety Interlock Service
    // This drives ABORT_REQUESTED -> ABORT_CONFIRMED and silences RF carrier
    const abortResult = await this.interlockService.commandPassAbort(
      directive.reservationId,
      directive.emergencyReason,
      {
        providerId: context.providerId,
        stationCode: context.stationCode,
      }
    );

    const executedAt = new Date();
    const latencyMs = Date.now() - startTime;

    // 6. Generate Tamper-Evident Execution Receipt
    const receiptId = `ABORT-RCPT-${crypto.randomUUID().slice(0, 8)}`;
    const proofPayload = `${receiptId}|${directive.directiveId}|${directive.dispatchId}|${abortResult.physicalSilenced}|${executedAt.toISOString()}`;
    const executionProof = crypto
      .createHmac("sha256", officer.secretKey)
      .update(proofPayload)
      .digest("hex");

    const executionReceipt: SecureAbortExecutionReceipt = {
      receiptId,
      directiveId: directive.directiveId,
      dispatchId: directive.dispatchId,
      reservationId: directive.reservationId,
      emergencyReason: directive.emergencyReason,
      carrierSilenced: abortResult.physicalSilenced,
      executedAt,
      latencyMs,
      officerId,
      executionProof,
    };

    logger.info(
      {
        receiptId,
        directiveId: directive.directiveId,
        carrierSilenced: executionReceipt.carrierSilenced,
        latencyMs,
      },
      "[SECURE_ABORT] Emergency carrier silence confirmed and receipt generated"
    );

    return executionReceipt;
  }

  /**
   * Reset channel state (for test isolation)
   */
  public reset(): void {
    this.authorizedOfficers.clear();
    this.lastSeenSequence.clear();
  }
}

export const secureAbortChannelService = new SecureAbortChannelService();
