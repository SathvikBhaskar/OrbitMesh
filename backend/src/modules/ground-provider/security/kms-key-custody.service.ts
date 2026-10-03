/**
 * Phase 5.8: Workstream 5.8.3 — Production Transport Security & Key Custody
 * Master Envelope Encryption and KMS / Vault Key Custody Service
 */

import crypto from "crypto";
import { logger } from "../../../config/logger";

export interface KeyEncryptionContext {
  readonly stationId: string;
  readonly keyId: string;
  readonly purpose: "TELEMETRY_SIGNING" | "COMMAND_UPLINK" | "ABORT_CHANNEL" | "SESSION_KEY";
}

export interface EncryptedKeyEnvelope {
  readonly keyId: string;
  readonly encryptedDek: string;       // base64: DEK encrypted under KMS Master KEK
  readonly ciphertext: string;         // base64: Secret key encrypted under DEK
  readonly iv: string;                 // hex: 96-bit AES-GCM IV
  readonly tag: string;                // hex: 128-bit AES-GCM Auth Tag
  readonly masterKeyId: string;        // KMS CMK ARN or Vault transit key
  readonly algorithm: "AES-256-GCM";
  readonly encryptedAt: string;        // ISO timestamp
  readonly contextHash: string;        // SHA-256 hash of encryption context
}

export interface KeyCustodyAuditRecord {
  readonly accessId: string;
  readonly timestamp: Date;
  readonly keyId: string;
  readonly stationId: string;
  readonly callerIdentity: string;
  readonly purpose: "ENCRYPT" | "DECRYPT" | "ROTATE" | "REVOKE";
  readonly success: boolean;
  readonly error?: string;
}

export interface IKmsVaultProvider {
  readonly providerType: "AWS_KMS" | "HASHICORP_VAULT" | "MOCK_HSM";
  encryptDek(plaintextDek: Buffer, masterKeyId: string): Promise<string>;
  decryptDek(encryptedDek: string, masterKeyId: string): Promise<Buffer>;
}

/**
 * Standard Mock/In-Memory HSM KMS provider (used in unit & conformance tests)
 */
export class LocalKmsVaultProvider implements IKmsVaultProvider {
  public readonly providerType = "MOCK_HSM";
  private readonly masterKeys = new Map<string, Buffer>(); // masterKeyId -> 256-bit KEK

  constructor(defaultMasterKeyId = "arn:aws:kms:us-east-1:123456789012:key/orbitmesh-ground-master") {
    // Initialize default master key
    this.masterKeys.set(defaultMasterKeyId, crypto.createHash("sha256").update("ORBITMESH_MASTER_KEK_SALT").digest());
  }

  public setMasterKey(masterKeyId: string, kekBytes: Buffer): void {
    this.masterKeys.set(masterKeyId, kekBytes);
  }

  async encryptDek(plaintextDek: Buffer, masterKeyId: string): Promise<string> {
    let kek = this.masterKeys.get(masterKeyId);
    if (!kek) {
      // Auto-provision deterministic key for new masterKeyId in local provider
      kek = crypto.createHash("sha256").update(masterKeyId).digest();
      this.masterKeys.set(masterKeyId, kek);
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", kek, iv);
    const enc = Buffer.concat([cipher.update(plaintextDek), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Packed envelope: iv (12 bytes) + tag (16 bytes) + ciphertext
    return Buffer.concat([iv, tag, enc]).toString("base64");
  }

  async decryptDek(encryptedDek: string, masterKeyId: string): Promise<Buffer> {
    const kek = this.masterKeys.get(masterKeyId);
    if (!kek) {
      throw new Error(`Master key not found in KMS: ${masterKeyId}`);
    }

    const raw = Buffer.from(encryptedDek, "base64");
    if (raw.length < 28) {
      throw new Error("Malformed encrypted DEK payload");
    }

    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);

    const decipher = crypto.createDecipheriv("aes-256-gcm", kek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}

export class KmsKeyCustodyService {
  private readonly kmsClient: IKmsVaultProvider;
  private readonly defaultMasterKeyId: string;
  private readonly auditLog: KeyCustodyAuditRecord[] = [];
  public static readonly DEFAULT_MASTER_KEY_ID = "arn:aws:kms:us-east-1:123456789012:key/orbitmesh-ground-master";

  constructor(
    kmsClient: IKmsVaultProvider = new LocalKmsVaultProvider(),
    defaultMasterKeyId = KmsKeyCustodyService.DEFAULT_MASTER_KEY_ID
  ) {
    this.kmsClient = kmsClient;
    this.defaultMasterKeyId = defaultMasterKeyId;
  }

  /**
   * Compute deterministic context hash
   */
  public hashContext(context: KeyEncryptionContext): string {
    const canonical = `${context.stationId}|${context.keyId}|${context.purpose}`;
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }

  /**
   * Envelope encrypt a sensitive secret key
   */
  async encryptSecret(
    plaintextSecret: string,
    context: KeyEncryptionContext,
    callerIdentity = "system",
    masterKeyId = this.defaultMasterKeyId
  ): Promise<EncryptedKeyEnvelope> {
    const accessId = `aud-${crypto.randomUUID().slice(0, 8)}`;
    const contextHash = this.hashContext(context);

    try {
      // 1. Generate ephemeral 256-bit Data Encryption Key (DEK)
      const dek = crypto.randomBytes(32);

      // 2. Encrypt plaintextSecret using AES-256-GCM under the ephemeral DEK
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", dek, iv);
      cipher.setAAD(Buffer.from(contextHash, "utf8")); // Bind context into GCM authentication
      const ciphertext = Buffer.concat([cipher.update(plaintextSecret, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();

      // 3. Encrypt the DEK under the Master Key via KMS/Vault
      const encryptedDek = await this.kmsClient.encryptDek(dek, masterKeyId);

      // 4. Securely wipe ephemeral plaintext DEK from memory
      dek.fill(0);

      const envelope: EncryptedKeyEnvelope = {
        keyId: context.keyId,
        encryptedDek,
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("hex"),
        tag: tag.toString("hex"),
        masterKeyId,
        algorithm: "AES-256-GCM",
        encryptedAt: new Date().toISOString(),
        contextHash,
      };

      // 5. Append audit record
      this.auditLog.push({
        accessId,
        timestamp: new Date(),
        keyId: context.keyId,
        stationId: context.stationId,
        callerIdentity,
        purpose: "ENCRYPT",
        success: true,
      });

      return envelope;
    } catch (err) {
      this.auditLog.push({
        accessId,
        timestamp: new Date(),
        keyId: context.keyId,
        stationId: context.stationId,
        callerIdentity,
        purpose: "ENCRYPT",
        success: false,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  /**
   * Decrypt an envelope-encrypted secret key
   */
  async decryptSecret(
    envelope: EncryptedKeyEnvelope,
    context: KeyEncryptionContext,
    callerIdentity = "system"
  ): Promise<string> {
    const accessId = `aud-${crypto.randomUUID().slice(0, 8)}`;

    try {
      // 1. Verify context hash to prevent transposition / context substitution attacks
      const expectedContextHash = this.hashContext(context);
      if (envelope.contextHash !== expectedContextHash) {
        throw new Error(
          `Security Context Mismatch: envelope bound to context [${envelope.contextHash}] does not match current context [${expectedContextHash}]`
        );
      }

      // 2. Decrypt DEK under Master Key via KMS
      const dek = await this.kmsClient.decryptDek(envelope.encryptedDek, envelope.masterKeyId);

      // 3. Decrypt ciphertext using DEK, IV, and Auth Tag
      const iv = Buffer.from(envelope.iv, "hex");
      const tag = Buffer.from(envelope.tag, "hex");
      const ciphertext = Buffer.from(envelope.ciphertext, "base64");

      const decipher = crypto.createDecipheriv("aes-256-gcm", dek, iv);
      decipher.setAAD(Buffer.from(envelope.contextHash, "utf8"));
      decipher.setAuthTag(tag);

      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");

      // 4. Securely wipe decrypted DEK buffer
      dek.fill(0);

      this.auditLog.push({
        accessId,
        timestamp: new Date(),
        keyId: context.keyId,
        stationId: context.stationId,
        callerIdentity,
        purpose: "DECRYPT",
        success: true,
      });

      return plaintext;
    } catch (err) {
      this.auditLog.push({
        accessId,
        timestamp: new Date(),
        keyId: context.keyId,
        stationId: context.stationId,
        callerIdentity,
        purpose: "DECRYPT",
        success: false,
        error: (err as Error).message,
      });
      logger.warn({ keyId: context.keyId, err: (err as Error).message }, "[KMS] Decryption failed or tampered");
      throw err;
    }
  }

  /**
   * Query key custody audit log for compliance inspection
   */
  public getAuditRecords(filter?: { keyId?: string; stationId?: string; purpose?: string }): KeyCustodyAuditRecord[] {
    return this.auditLog.filter((record) => {
      if (filter?.keyId && record.keyId !== filter.keyId) return false;
      if (filter?.stationId && record.stationId !== filter.stationId) return false;
      if (filter?.purpose && record.purpose !== filter.purpose) return false;
      return true;
    });
  }

  /**
   * Clear audit log (for test reset)
   */
  public clearAuditLog(): void {
    this.auditLog.length = 0;
  }
}

export const kmsKeyCustodyService = new KmsKeyCustodyService();
