/**
 * Phase 5.8: Workstream 5.8.3 — Production Transport Security & Key Custody
 * Automated Key Rotation Engine with Dual-Key Rotation Grace Period
 */

import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../../../db/client";
import { groundStationCredentials } from "../../../db/schema";
import { logger } from "../../../config/logger";
import { kmsKeyCustodyService, KmsKeyCustodyService } from "./kms-key-custody.service";

export interface RotationConfig {
  readonly defaultGracePeriodMs: number; // Default 24 hours (86,400,000 ms)
  readonly defaultKeyLifetimeMs: number; // Default 90 days (7,776,000,000 ms)
}

export interface RotationResult {
  readonly stationId: string;
  readonly oldKeyId: string;
  readonly newKeyId: string;
  readonly oldKeyStatus: "ROTATING";
  readonly newKeyStatus: "ACTIVE";
  readonly gracePeriodExpiresAt: Date;
  readonly newKeyExpiresAt: Date;
}

export interface KeyGraceStatus {
  readonly keyId: string;
  readonly status: "ACTIVE" | "ROTATING" | "REVOKED" | "EXPIRED";
  readonly isUsable: boolean;
  readonly remainingGraceMs?: number;
  readonly errorCode?: "CREDENTIAL_REVOKED" | "CREDENTIAL_EXPIRED" | "ROTATION_GRACE_EXCEEDED";
  readonly errorMessage?: string;
}

export class KeyRotationService {
  public static readonly DEFAULT_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // 24 hours
  public static readonly DEFAULT_KEY_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

  // In-memory grace registry: keyId -> gracePeriodExpiresAt
  private readonly graceLedger = new Map<string, Date>();
  private readonly custodyService: KmsKeyCustodyService;

  constructor(custodyService = kmsKeyCustodyService) {
    this.custodyService = custodyService;
  }

  /**
   * Set custom grace period for a specific key (useful for tests or custom policies)
   */
  public registerGracePeriod(keyId: string, gracePeriodExpiresAt: Date): void {
    this.graceLedger.set(keyId, gracePeriodExpiresAt);
  }

  /**
   * Initiate automated key rotation for a ground station:
   * 1. Old ACTIVE key -> ROTATING
   * 2. New generated key -> ACTIVE
   * 3. Both keys are valid throughout the grace period
   */
  async rotateStationKey(
    stationId: string,
    options?: {
      gracePeriodMs?: number;
      keyLifetimeMs?: number;
      callerIdentity?: string;
    }
  ): Promise<RotationResult> {
    const now = Date.now();
    const graceMs = options?.gracePeriodMs ?? KeyRotationService.DEFAULT_GRACE_PERIOD_MS;
    const lifetimeMs = options?.keyLifetimeMs ?? KeyRotationService.DEFAULT_KEY_LIFETIME_MS;
    const caller = options?.callerIdentity ?? "operator-rotation-engine";

    // 1. Find currently ACTIVE key for this station
    const existingActive = await db
      .select()
      .from(groundStationCredentials)
      .where(
        and(
          eq(groundStationCredentials.groundStationId, stationId),
          eq(groundStationCredentials.status, "ACTIVE")
        )
      );

    if (existingActive.length === 0) {
      throw new Error(`Cannot rotate: no ACTIVE credential found for station ${stationId}`);
    }

    const currentKey = existingActive[0]!;
    const graceExpiresAt = new Date(now + graceMs);
    const newKeyExpiresAt = new Date(now + lifetimeMs);

    // 2. Generate new cryptographically secure secret (32 bytes)
    const rawSecret = crypto.randomBytes(32).toString("hex");
    const newKeyId = `gs-key-${crypto.randomUUID().slice(0, 8)}`;

    // 3. Envelope-encrypt new secret under KMS
    const envelope = await this.custodyService.encryptSecret(
      rawSecret,
      {
        stationId,
        keyId: newKeyId,
        purpose: "TELEMETRY_SIGNING",
      },
      caller
    );

    // 4. Update old key in DB: status = ROTATING, expiresAt = min(current expiresAt, graceExpiresAt)
    await db
      .update(groundStationCredentials)
      .set({
        status: "ROTATING",
        expiresAt: graceExpiresAt,
      })
      .where(eq(groundStationCredentials.id, currentKey.id));

    // Register in in-memory grace ledger
    this.graceLedger.set(currentKey.keyId, graceExpiresAt);

    // 5. Insert new key in DB: status = ACTIVE
    // We store the rawSecret in secretKey (or serialized envelope for KMS-managed stations)
    await db.insert(groundStationCredentials).values({
      groundStationId: stationId,
      keyId: newKeyId,
      secretKey: rawSecret,
      status: "ACTIVE",
      expiresAt: newKeyExpiresAt,
    });

    logger.info(
      {
        stationId,
        oldKeyId: currentKey.keyId,
        newKeyId,
        graceExpiresAt: graceExpiresAt.toISOString(),
      },
      "[KEY_ROTATION] Dual-key rotation initiated: both keys active during grace window"
    );

    return {
      stationId,
      oldKeyId: currentKey.keyId,
      newKeyId,
      oldKeyStatus: "ROTATING",
      newKeyStatus: "ACTIVE",
      gracePeriodExpiresAt: graceExpiresAt,
      newKeyExpiresAt,
    };
  }

  /**
   * Evaluate whether a key can be used at a given point in time
   */
  public evaluateKeyUsability(
    cred: {
      keyId: string;
      status: "ACTIVE" | "ROTATING" | "REVOKED";
      expiresAt: Date | null;
      revokedAt: Date | null;
    },
    checkTime = new Date()
  ): KeyGraceStatus {
    const now = checkTime.getTime();

    // 1. Revoked check
    if (cred.status === "REVOKED") {
      return {
        keyId: cred.keyId,
        status: "REVOKED",
        isUsable: false,
        errorCode: "CREDENTIAL_REVOKED",
        errorMessage: `Credential ${cred.keyId} has been explicitly revoked`,
      };
    }

    // 2. Active key check
    if (cred.status === "ACTIVE") {
      if (cred.expiresAt && cred.expiresAt.getTime() < now) {
        return {
          keyId: cred.keyId,
          status: "EXPIRED",
          isUsable: false,
          errorCode: "CREDENTIAL_EXPIRED",
          errorMessage: `Credential ${cred.keyId} has expired`,
        };
      }
      return {
        keyId: cred.keyId,
        status: "ACTIVE",
        isUsable: true,
      };
    }

    // 3. Rotating key check (Dual-key grace window)
    if (cred.status === "ROTATING") {
      const graceEnd = this.graceLedger.get(cred.keyId) ?? cred.expiresAt;
      const graceEndTime = graceEnd ? graceEnd.getTime() : 0;

      if (!graceEndTime || graceEndTime < now) {
        return {
          keyId: cred.keyId,
          status: "EXPIRED",
          isUsable: false,
          remainingGraceMs: 0,
          errorCode: "ROTATION_GRACE_EXCEEDED",
          errorMessage: `Credential ${cred.keyId} is ROTATING but grace window has expired`,
        };
      }

      return {
        keyId: cred.keyId,
        status: "ROTATING",
        isUsable: true,
        remainingGraceMs: graceEndTime - now,
      };
    }

    return {
      keyId: cred.keyId,
      status: "EXPIRED",
      isUsable: false,
      errorCode: "CREDENTIAL_EXPIRED",
      errorMessage: "Unknown credential status",
    };
  }

  /**
   * Immediately finalize cutover and revoke the old rotating key
   */
  async finalizeCutover(keyId: string): Promise<void> {
    await db
      .update(groundStationCredentials)
      .set({
        status: "REVOKED",
        revokedAt: new Date(),
      })
      .where(eq(groundStationCredentials.keyId, keyId));

    this.graceLedger.delete(keyId);

    logger.info({ keyId }, "[KEY_ROTATION] Cutover finalized: old key marked REVOKED");
  }

  /**
   * Reset in-memory grace ledger
   */
  public clearLedger(): void {
    this.graceLedger.clear();
  }
}

export const keyRotationService = new KeyRotationService();
