import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { groundStationCredentials } from "../../db/schema";
import {
  SignedPayloadHeader,
  SignatureVerificationResult,
} from "./provider.types";
import { logger } from "../../config/logger";

export class GroundSecurityService {
  public static readonly MAX_TIMESTAMP_SKEW_MS = 5000; // ±5 seconds
  private static readonly seenNonces = new Map<string, number>(); // nonce -> expiry timestamp
  private static readonly CLEANUP_INTERVAL_MS = 60000;

  constructor() {
    // Periodic nonce cache cleanup
    setInterval(() => {
      const now = Date.now();
      for (const [nonce, expiresAt] of GroundSecurityService.seenNonces.entries()) {
        if (expiresAt < now) {
          GroundSecurityService.seenNonces.delete(nonce);
        }
      }
    }, GroundSecurityService.CLEANUP_INTERVAL_MS).unref();
  }

  /**
   * 1. Build canonical string for signing:
   * dispatchId | sequenceNumber | sourceTimestamp | nonce | payloadJson
   */
  public buildCanonicalString(
    dispatchId: string,
    sequenceNumber: number,
    sourceTimestamp: string,
    nonce: string,
    payload: Record<string, unknown>
  ): string {
    // Deterministic payload serialization (sorted keys)
    const sortedKeys = Object.keys(payload).sort();
    const sortedPayload: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      sortedPayload[key] = payload[key];
    }
    const payloadJson = JSON.stringify(sortedPayload);

    return `${dispatchId}|${sequenceNumber}|${sourceTimestamp}|${nonce}|${payloadJson}`;
  }

  /**
   * 2. Generate HMAC-SHA256 signature (used by stations or test harness)
   */
  public generateSignature(secretKey: string, canonicalString: string): string {
    return crypto
      .createHmac("sha256", secretKey)
      .update(canonicalString)
      .digest("hex");
  }

  /**
   * 3. Verify incoming signed telemetry packet
   */
  async verifyTelemetrySignature(
    headers: SignedPayloadHeader,
    dispatchId: string,
    sequenceNumber: number,
    payload: Record<string, unknown>
  ): Promise<SignatureVerificationResult> {
    const { keyId, signature, nonce, timestamp } = headers;

    if (!keyId || !signature || !nonce || !timestamp) {
      return {
        isValid: false,
        errorCode: "MISSING_HEADERS",
        errorMessage: "Missing required security headers (keyId, signature, nonce, timestamp)",
      };
    }

    // 1. Clock skew validation
    const headerTime = new Date(timestamp).getTime();
    const now = Date.now();
    if (isNaN(headerTime) || Math.abs(headerTime - now) > GroundSecurityService.MAX_TIMESTAMP_SKEW_MS) {
      return {
        isValid: false,
        errorCode: "CLOCK_SKEW_EXCEEDED",
        errorMessage: `Timestamp skew exceeds ${GroundSecurityService.MAX_TIMESTAMP_SKEW_MS}ms tolerance`,
      };
    }

    // 2. Anti-replay nonce validation
    if (GroundSecurityService.seenNonces.has(nonce)) {
      return {
        isValid: false,
        errorCode: "NONCE_REPLAY_DETECTED",
        errorMessage: "Nonce replay detected; packet discarded",
      };
    }

    // 3. Database credential lookup
    const credRows = await db
      .select()
      .from(groundStationCredentials)
      .where(eq(groundStationCredentials.keyId, keyId));

    if (credRows.length === 0) {
      return {
        isValid: false,
        errorCode: "CREDENTIAL_NOT_FOUND",
        errorMessage: `Ground station keyId ${keyId} not registered`,
      };
    }

    const cred = credRows[0]!;

    // 4. Credential lifecycle checks
    if (cred.status === "REVOKED") {
      logger.warn({ keyId, stationId: cred.groundStationId }, "Telemetry rejected: key has been REVOKED");
      return {
        isValid: false,
        stationId: cred.groundStationId,
        keyId,
        errorCode: "CREDENTIAL_REVOKED",
        errorMessage: `Key ${keyId} has been revoked`,
      };
    }

    if (cred.expiresAt && cred.expiresAt.getTime() < now) {
      logger.warn({ keyId, stationId: cred.groundStationId }, "Telemetry rejected: key has EXPIRED");
      return {
        isValid: false,
        stationId: cred.groundStationId,
        keyId,
        errorCode: "CREDENTIAL_EXPIRED",
        errorMessage: `Key ${keyId} has expired`,
      };
    }

    // 5. Signature verification (constant-time compare)
    const canonical = this.buildCanonicalString(
      dispatchId,
      sequenceNumber,
      timestamp,
      nonce,
      payload
    );

    const expectedSig = this.generateSignature(cred.secretKey, canonical);

    try {
      const sigBuffer = Buffer.from(signature, "hex");
      const expectedBuffer = Buffer.from(expectedSig, "hex");

      if (
        sigBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
      ) {
        logger.warn({ keyId, dispatchId }, "Telemetry rejected: invalid HMAC signature");
        return {
          isValid: false,
          stationId: cred.groundStationId,
          keyId,
          errorCode: "INVALID_SIGNATURE",
          errorMessage: "HMAC signature mismatch",
        };
      }
    } catch {
      return {
        isValid: false,
        stationId: cred.groundStationId,
        keyId,
        errorCode: "INVALID_SIGNATURE",
        errorMessage: "Malformed signature encoding",
      };
    }

    // Record nonce with 10-minute TTL to prevent replay
    GroundSecurityService.seenNonces.set(nonce, now + 600000);

    return {
      isValid: true,
      stationId: cred.groundStationId,
      keyId,
    };
  }

  /**
   * Helper to clear nonce cache (useful for isolated tests)
   */
  public clearNonceCache(): void {
    GroundSecurityService.seenNonces.clear();
  }
}

export const groundSecurityService = new GroundSecurityService();
export const groundStationCryptoService = groundSecurityService;
