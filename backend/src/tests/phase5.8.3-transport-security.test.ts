/**
 * Phase 5.8: Workstream 5.8.3 — Production Transport Security & Key Custody Test Suite
 * 
 * Verifies:
 * 1. X.509 Mutual TLS (mTLS) & Root/Intermediate CA Trust Chains
 * 2. Certificate Lifecycle, CRL Distribution, and OCSP Stapling Revocation
 * 3. KMS / Vault Master Envelope Encryption & Key Custody Audit Logging
 * 4. Automated Key Rotation & Dual-Key Rotation Grace Period
 * 5. Secure Abort Channel: Out-of-band Priority Execution & Interlock Coupling
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import {
  satellites,
  groundStations,
  contactWindows,
  missionTasks,
  reservations,
  satelliteOrbitalData,
  groundStationCredentials,
} from "../db/schema";
import {
  MtlsValidatorService,
  CrlOcspService,
  KmsKeyCustodyService,
  LocalKmsVaultProvider,
  KeyRotationService,
  SecureAbortChannelService,
  EncryptedKeyEnvelope,
} from "../modules/ground-provider/security";
import { groundSecurityService } from "../modules/ground-provider/crypto.service";
import { providerRegistry } from "../modules/ground-provider/provider.registry";
import { DispatchContext } from "../modules/ground-provider/provider.types";
import {
  ROOT_CA_CERT_PEM,
  INTERMEDIATE_CA_CERT_PEM,
  VALID_LEAF_CERT_PEM,
  SAN_MISMATCH_LEAF_CERT_PEM,
  ROGUE_ROOT_CA_CERT_PEM,
  ROGUE_LEAF_CERT_PEM,
} from "./fixtures/pki-fixtures";

describe("Phase 5.8.3: Production Transport Security & Key Custody", () => {
  let mtlsValidator: MtlsValidatorService;
  let crlOcsp: CrlOcspService;
  let kmsCustody: KmsKeyCustodyService;
  let keyRotation: KeyRotationService;
  let secureAbort: SecureAbortChannelService;

  // DB test fixture IDs
  let satId: string;
  let odId: string;
  let stationId: string;
  let missionTaskId: string;
  let contactWindowId: string;
  let reservationId: string;
  let windowAos: Date;
  let windowLos: Date;

  beforeAll(async () => {
    windowAos = new Date(Date.now() + 3600000);
    windowLos = new Date(Date.now() + 4200000);

    // 1. Seed Satellite
    const [sat] = await db
      .insert(satellites)
      .values({
        noradId: 58300 + Math.floor(Math.random() * 900),
        name: "SEC-TEST-SAT",
        status: "ACTIVE",
      })
      .returning();
    satId = sat!.id;

    const [od] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: satId,
        source: "CELESTRAK",
        tleLine1: "1 58300U 26001A   26270.00000000  .00001000  00000-0  10000-3 0  9991",
        tleLine2: "2 58300  97.5000 120.0000 0010000  45.0000 315.0000 15.10000000000018",
        tleEpoch: new Date(),
        receivedAt: new Date(),
      })
      .returning();
    odId = od!.id;

    // 2. Seed Ground Station
    const [station] = await db
      .insert(groundStations)
      .values({
        code: `SEC-GS-${Math.floor(Math.random() * 9000 + 1000)}`,
        name: "Security-Ground-Station",
        latitude: 40.0,
        longitude: -80.0,
        minimumElevationDeg: 5,
        status: "AVAILABLE",
        supportedFrequencyBands: ["S_BAND", "X_BAND"],
      })
      .returning();
    stationId = station!.id;

    // 3. Seed Mission Task
    const [task] = await db
      .insert(missionTasks)
      .values({
        satelliteId: satId,
        name: "Security-Task",
        priority: 1,
        durationSeconds: 600,
        deadline: new Date(Date.now() + 86400000),
        status: "SCHEDULED",
        requiredFrequencyBand: "S_BAND",
        minDataRateMbps: 50,
      })
      .returning();
    missionTaskId = task!.id;

    // 4. Seed Contact Window
    const [window] = await db
      .insert(contactWindows)
      .values({
        satelliteId: satId,
        groundStationId: stationId,
        orbitalDataId: odId,
        aos: windowAos,
        los: windowLos,
        durationSeconds: 600,
        maxElevationDeg: 45,
      })
      .returning();
    contactWindowId = window!.id;
  });

  afterAll(async () => {
    // Cleanup DB fixtures
    await db.delete(reservations).where(eq(reservations.satelliteId, satId));
    await db.delete(contactWindows).where(eq(contactWindows.satelliteId, satId));
    await db.delete(missionTasks).where(eq(missionTasks.satelliteId, satId));
    await db.delete(satelliteOrbitalData).where(eq(satelliteOrbitalData.satelliteId, satId));
    await db.delete(satellites).where(eq(satellites.id, satId));
    await db.delete(groundStationCredentials).where(eq(groundStationCredentials.groundStationId, stationId));
    await db.delete(groundStations).where(eq(groundStations.id, stationId));
  });

  beforeEach(async () => {
    crlOcsp = new CrlOcspService();
    mtlsValidator = new MtlsValidatorService(
      {
        trustedRoots: [ROOT_CA_CERT_PEM],
        trustedIntermediates: [INTERMEDIATE_CA_CERT_PEM],
      },
      crlOcsp
    );
    kmsCustody = new KmsKeyCustodyService(new LocalKmsVaultProvider());
    keyRotation = new KeyRotationService(kmsCustody);
    secureAbort = new SecureAbortChannelService();
    groundSecurityService.clearNonceCache();

    // Clean up any lingering reservations from previous test
    await db.delete(reservations).where(eq(reservations.satelliteId, satId));

    // Create a fresh reservation for safety tests matching windowAos and windowLos exactly
    const [res] = await db
      .insert(reservations)
      .values({
        satelliteId: satId,
        groundStationId: stationId,
        missionTaskId: missionTaskId,
        contactWindowId: contactWindowId,
        windowAos,
        windowLos,
        allocatedStart: windowAos,
        allocatedEnd: windowLos,
        taskDurationSeconds: 600,
        status: "CONFIRMED",
        executionState: "SCHEDULED",
        executionInterlock: "NONE",
      })
      .returning();
    reservationId = res!.id;
  });

  // =========================================================================
  // 1. X.509 Mutual TLS (mTLS) & CA Trust Chains
  // =========================================================================
  describe("1. X.509 mTLS & CA Trust Chain Validation", () => {
    it("accepts valid full certificate chain (Root -> Intermediate -> Leaf)", () => {
      const result = mtlsValidator.validateCertificate(VALID_LEAF_CERT_PEM, [INTERMEDIATE_CA_CERT_PEM], {
        expectedHostname: "groundstation.us-east-1.amazonaws.com",
      });

      expect(result.isValid).toBe(true);
      expect(result.chainDepth).toBe(3);
      expect(result.leafSubject).toContain("groundstation.us-east-1.amazonaws.com");
      expect(result.rootFingerprint256).toBeDefined();
    });

    it("accepts valid chain when intermediate is pre-loaded in trust store", () => {
      // Omit chain bundle because intermediate is anchored in trust store
      const result = mtlsValidator.validateCertificate(VALID_LEAF_CERT_PEM, [], {
        expectedHostname: "redu-1.sle.esa.int",
      });

      expect(result.isValid).toBe(true);
      expect(result.chainDepth).toBe(3);
    });

    it("rejects broken chain when intermediate is missing from both bundle and store", () => {
      const strictValidator = new MtlsValidatorService({
        trustedRoots: [ROOT_CA_CERT_PEM],
        // No intermediates registered
      });

      const result = strictValidator.validateCertificate(VALID_LEAF_CERT_PEM, [], {
        expectedHostname: "groundstation.us-east-1.amazonaws.com",
      });

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("CHAIN_BROKEN");
      expect(result.errorMessage).toContain("Chain broken");
    });

    it("rejects untrusted root CA not present in Trust Store", () => {
      const result = mtlsValidator.validateCertificate(ROGUE_LEAF_CERT_PEM, [], {
        expectedHostname: "groundstation.us-east-1.amazonaws.com",
      });

      expect(result.isValid).toBe(false);
      expect(["UNTRUSTED_ROOT", "CHAIN_BROKEN"]).toContain(result.errorCode);
    });

    it("rejects leaf certificate with SAN / Hostname mismatch", () => {
      const result = mtlsValidator.validateCertificate(SAN_MISMATCH_LEAF_CERT_PEM, [INTERMEDIATE_CA_CERT_PEM], {
        expectedHostname: "groundstation.us-east-1.amazonaws.com",
      });

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("SAN_MISMATCH");
      expect(result.errorMessage).toContain("Hostname [groundstation.us-east-1.amazonaws.com] does not match");
    });

    it("rejects certificate when validationTime is past expiration date", () => {
      // Set test time to year 2040 (past 1-year leaf validity)
      const futureDate = new Date("2040-01-01T00:00:00Z");

      const result = mtlsValidator.validateCertificate(VALID_LEAF_CERT_PEM, [INTERMEDIATE_CA_CERT_PEM], {
        expectedHostname: "groundstation.us-east-1.amazonaws.com",
        validationTime: futureDate,
      });

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("CERT_EXPIRED");
    });

    it("rejects certificate when validationTime is before notBefore date", () => {
      // Set test time to year 2010 (before creation date)
      const pastDate = new Date("2010-01-01T00:00:00Z");

      const result = mtlsValidator.validateCertificate(VALID_LEAF_CERT_PEM, [INTERMEDIATE_CA_CERT_PEM], {
        expectedHostname: "groundstation.us-east-1.amazonaws.com",
        validationTime: pastDate,
      });

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("CERT_NOT_YET_VALID");
    });
  });

  // =========================================================================
  // 2. Certificate Lifecycle, CRL & OCSP Revocation
  // =========================================================================
  describe("2. Certificate Lifecycle, CRL & OCSP Revocation", () => {
    it("rejects certificate explicitly revoked in CRL distribution", () => {
      const leafCert = new crypto.X509Certificate(VALID_LEAF_CERT_PEM);

      // Register CRL containing this leaf certificate serial
      crlOcsp.registerCrl({
        issuer: leafCert.issuer,
        thisUpdate: new Date(Date.now() - 3600000),
        nextUpdate: new Date(Date.now() + 86400000),
        revoked: [
          {
            serialNumber: leafCert.serialNumber,
            revocationDate: new Date(Date.now() - 1800000),
            reason: "KEY_COMPROMISE",
          },
        ],
      });

      const result = mtlsValidator.validateCertificate(VALID_LEAF_CERT_PEM, [INTERMEDIATE_CA_CERT_PEM], {
        expectedHostname: "groundstation.us-east-1.amazonaws.com",
      });

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("REVOKED_CRL");
      expect(result.errorMessage).toContain("KEY_COMPROMISE");
    });

    it("accepts certificate verified with valid OCSP GOOD status", () => {
      const leafCert = new crypto.X509Certificate(VALID_LEAF_CERT_PEM);
      const nonce = crypto.randomBytes(16).toString("hex");

      crlOcsp.setOcspStatus(leafCert.serialNumber, "GOOD");
      const ocspResponse = crlOcsp.generateOcspResponse(leafCert, nonce);

      const result = mtlsValidator.validateCertificate(VALID_LEAF_CERT_PEM, [INTERMEDIATE_CA_CERT_PEM], {
        expectedHostname: "groundstation.us-east-1.amazonaws.com",
        ocspResponse: {
          response: ocspResponse,
          expectedNonce: nonce,
        },
      });

      expect(result.isValid).toBe(true);
    });

    it("rejects certificate when OCSP responder reports REVOKED", () => {
      const leafCert = new crypto.X509Certificate(VALID_LEAF_CERT_PEM);
      const nonce = crypto.randomBytes(16).toString("hex");

      crlOcsp.setOcspStatus(leafCert.serialNumber, "REVOKED", {
        revocationReason: "SUPERSEDED",
        revocationTime: new Date(),
      });
      const ocspResponse = crlOcsp.generateOcspResponse(leafCert, nonce);

      const result = mtlsValidator.validateCertificate(VALID_LEAF_CERT_PEM, [INTERMEDIATE_CA_CERT_PEM], {
        expectedHostname: "groundstation.us-east-1.amazonaws.com",
        ocspResponse: {
          response: ocspResponse,
          expectedNonce: nonce,
        },
      });

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("REVOKED_OCSP");
      expect(result.errorMessage).toContain("SUPERSEDED");
    });

    it("rejects OCSP response when nonce is mismatched (replay protection)", () => {
      const leafCert = new crypto.X509Certificate(VALID_LEAF_CERT_PEM);
      crlOcsp.setOcspStatus(leafCert.serialNumber, "GOOD");
      const staleNonce = "nonce-stale-attempt-1";
      const currentNonce = "nonce-current-attempt-2";

      const staleResponse = crlOcsp.generateOcspResponse(leafCert, staleNonce);

      const result = mtlsValidator.validateCertificate(VALID_LEAF_CERT_PEM, [INTERMEDIATE_CA_CERT_PEM], {
        expectedHostname: "groundstation.us-east-1.amazonaws.com",
        ocspResponse: {
          response: staleResponse,
          expectedNonce: currentNonce, // Mismatch!
        },
      });

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("OCSP_REPLAY_DETECTED");
    });

    it("evaluates certificate lifecycle states correctly (VALID, EXPIRING_SOON, EXPIRED, REVOKED)", () => {
      const leafCert = new crypto.X509Certificate(VALID_LEAF_CERT_PEM);

      // State: VALID (now)
      const validStatus = crlOcsp.evaluateLifecycle(leafCert, new Date());
      expect(validStatus.state).toBe("VALID");

      // State: EXPIRING_SOON (evaluated 10 days before expiry)
      const nearExpiry = new Date(new Date(leafCert.validTo).getTime() - 10 * 86400000);
      const expiringSoonStatus = crlOcsp.evaluateLifecycle(leafCert, nearExpiry, 30);
      expect(expiringSoonStatus.state).toBe("EXPIRING_SOON");
      expect(expiringSoonStatus.daysUntilExpiration).toBeLessThanOrEqual(30);

      // State: EXPIRED (evaluated 1 day after expiry)
      const afterExpiry = new Date(new Date(leafCert.validTo).getTime() + 86400000);
      const expiredStatus = crlOcsp.evaluateLifecycle(leafCert, afterExpiry);
      expect(expiredStatus.state).toBe("EXPIRED");

      // State: REVOKED (via CRL)
      crlOcsp.registerCrl({
        issuer: leafCert.issuer,
        thisUpdate: new Date(),
        nextUpdate: new Date(Date.now() + 86400000),
        revoked: [{ serialNumber: leafCert.serialNumber, revocationDate: new Date() }],
      });
      const revokedStatus = crlOcsp.evaluateLifecycle(leafCert, new Date());
      expect(revokedStatus.state).toBe("REVOKED");
    });
  });

  // =========================================================================
  // 3. KMS / Vault Master Envelope Encryption & Key Custody
  // =========================================================================
  describe("3. KMS / Vault Key Custody & Master Envelope Encryption", () => {
    it("successfully envelope-encrypts and decrypts secret under KMS master key", async () => {
      const plaintextSecret = "super-secret-pre-shared-ground-station-key-32b!";
      const context = {
        stationId,
        keyId: "key-kms-001",
        purpose: "TELEMETRY_SIGNING" as const,
      };

      const envelope = await kmsCustody.encryptSecret(plaintextSecret, context, "operator-alice");

      expect(envelope.algorithm).toBe("AES-256-GCM");
      expect(envelope.encryptedDek).toBeDefined();
      expect(envelope.ciphertext).toBeDefined();
      expect(envelope.ciphertext).not.toBe(plaintextSecret);
      expect(envelope.contextHash).toBe(kmsCustody.hashContext(context));

      // Decrypt
      const decrypted = await kmsCustody.decryptSecret(envelope, context, "ground-station-agent");
      expect(decrypted).toBe(plaintextSecret);
    });

    it("rejects decryption if security context is altered (transposition defense)", async () => {
      const plaintextSecret = "confidential-station-credential";
      const originalContext = {
        stationId,
        keyId: "key-station-alpha",
        purpose: "TELEMETRY_SIGNING" as const,
      };

      const envelope = await kmsCustody.encryptSecret(plaintextSecret, originalContext);

      // Attacker tries to use envelope for station-beta
      const maliciousContext = {
        stationId: "rogue-station-beta",
        keyId: "key-station-alpha",
        purpose: "TELEMETRY_SIGNING" as const,
      };

      await expect(kmsCustody.decryptSecret(envelope, maliciousContext)).rejects.toThrow(
        /Security Context Mismatch/
      );
    });

    it("detects and rejects tampered ciphertext or modified auth tag", async () => {
      const plaintext = "tamper-test-secret";
      const context = { stationId, keyId: "key-tamper-01", purpose: "SESSION_KEY" as const };

      const envelope = await kmsCustody.encryptSecret(plaintext, context);

      // Tamper ciphertext
      const tamperedBytes = Buffer.from(envelope.ciphertext, "base64");
      tamperedBytes[0] = (tamperedBytes[0]! ^ 0xff);
      const tamperedEnvelope: EncryptedKeyEnvelope = {
        ...envelope,
        ciphertext: tamperedBytes.toString("base64"),
      };

      await expect(kmsCustody.decryptSecret(tamperedEnvelope, context)).rejects.toThrow();
    });

    it("records tamper-evident audit records on key access events", async () => {
      kmsCustody.clearAuditLog();
      const context = { stationId, keyId: "key-audit-99", purpose: "ABORT_CHANNEL" as const };

      const env = await kmsCustody.encryptSecret("secret-data", context, "user-bob");
      await kmsCustody.decryptSecret(env, context, "service-ingest");

      const records = kmsCustody.getAuditRecords({ keyId: "key-audit-99" });
      expect(records.length).toBe(2);

      expect(records[0]!.purpose).toBe("ENCRYPT");
      expect(records[0]!.callerIdentity).toBe("user-bob");
      expect(records[0]!.success).toBe(true);

      expect(records[1]!.purpose).toBe("DECRYPT");
      expect(records[1]!.callerIdentity).toBe("service-ingest");
      expect(records[1]!.success).toBe(true);
    });
  });

  // =========================================================================
  // 4. Automated Key Rotation & Dual-Key Rotation Grace Period
  // =========================================================================
  describe("4. Automated Key Rotation & Dual-Key Grace Period", () => {
    it("orchestrates zero-downtime dual-key rotation: both old and new keys valid during grace window", async () => {
      // 1. Seed initial ACTIVE credential
      const oldKeyId = `gs-key-old-${crypto.randomUUID().slice(0, 8)}`;
      const oldSecret = "old-active-ground-station-secret-key-32b!";
      await db.insert(groundStationCredentials).values({
        groundStationId: stationId,
        keyId: oldKeyId,
        secretKey: oldSecret,
        status: "ACTIVE",
        expiresAt: new Date(Date.now() + 86400000 * 30),
      });

      // 2. Initiate rotation with 24-hour grace window
      const gracePeriodMs = 24 * 60 * 60 * 1000;
      const rotationResult = await keyRotation.rotateStationKey(stationId, {
        gracePeriodMs,
      });

      expect(rotationResult.oldKeyId).toBe(oldKeyId);
      expect(rotationResult.oldKeyStatus).toBe("ROTATING");
      expect(rotationResult.newKeyStatus).toBe("ACTIVE");

      // Verify old key marked ROTATING and new key ACTIVE in database
      const [oldDbCred] = await db
        .select()
        .from(groundStationCredentials)
        .where(eq(groundStationCredentials.keyId, oldKeyId));
      expect(oldDbCred!.status).toBe("ROTATING");

      const [newDbCred] = await db
        .select()
        .from(groundStationCredentials)
        .where(eq(groundStationCredentials.keyId, rotationResult.newKeyId));
      expect(newDbCred!.status).toBe("ACTIVE");

      // 3. Test telemetry signed with NEW key during grace period -> ACCEPTED
      const dispatchId = `disp-rot-${Date.now()}`;
      const payload = { snr: 15.4, carrierLocked: true };
      const nowIso = new Date().toISOString();
      const nonceNew = `nonce-new-${crypto.randomUUID().slice(0, 8)}`;

      const canonNew = groundSecurityService.buildCanonicalString(dispatchId, 1, nowIso, nonceNew, payload);
      const sigNew = groundSecurityService.generateSignature(newDbCred!.secretKey, canonNew);

      const verifyNewResult = await groundSecurityService.verifyTelemetrySignature(
        { keyId: rotationResult.newKeyId, signature: sigNew, nonce: nonceNew, timestamp: nowIso },
        dispatchId,
        1,
        payload
      );
      expect(verifyNewResult.isValid).toBe(true);

      // 4. Test telemetry signed with OLD (ROTATING) key during grace period -> ALSO ACCEPTED!
      const nonceOld = `nonce-old-${crypto.randomUUID().slice(0, 8)}`;
      const canonOld = groundSecurityService.buildCanonicalString(dispatchId, 2, nowIso, nonceOld, payload);
      const sigOld = groundSecurityService.generateSignature(oldSecret, canonOld);

      const verifyOldResult = await groundSecurityService.verifyTelemetrySignature(
        { keyId: oldKeyId, signature: sigOld, nonce: nonceOld, timestamp: nowIso },
        dispatchId,
        2,
        payload
      );
      expect(verifyOldResult.isValid).toBe(true);
    });

    it("rejects rotating key once the grace period expires", async () => {
      const expiringKeyId = `gs-key-grace-exp-${crypto.randomUUID().slice(0, 8)}`;
      const secret = "grace-expiration-test-secret-32b!";
      // Grace expired 1 hour ago
      const graceExpiredAt = new Date(Date.now() - 3600000);

      await db.insert(groundStationCredentials).values({
        groundStationId: stationId,
        keyId: expiringKeyId,
        secretKey: secret,
        status: "ROTATING",
        expiresAt: graceExpiredAt,
      });
      keyRotation.registerGracePeriod(expiringKeyId, graceExpiredAt);

      const dispatchId = `disp-grace-exp-${Date.now()}`;
      const payload = { snr: 12.0, carrierLocked: true };
      const nowIso = new Date().toISOString();
      const nonce = `nonce-exp-${crypto.randomUUID().slice(0, 8)}`;

      const canon = groundSecurityService.buildCanonicalString(dispatchId, 1, nowIso, nonce, payload);
      const sig = groundSecurityService.generateSignature(secret, canon);

      const result = await groundSecurityService.verifyTelemetrySignature(
        { keyId: expiringKeyId, signature: sig, nonce, timestamp: nowIso },
        dispatchId,
        1,
        payload
      );

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe("ROTATION_GRACE_EXCEEDED");
      expect(result.errorMessage).toContain("grace window has expired");
    });

    it("immediately revokes old key when cutover is finalized", async () => {
      const cutoverKeyId = `gs-key-cutover-${crypto.randomUUID().slice(0, 8)}`;
      await db.insert(groundStationCredentials).values({
        groundStationId: stationId,
        keyId: cutoverKeyId,
        secretKey: "cutover-secret",
        status: "ROTATING",
        expiresAt: new Date(Date.now() + 86400000),
      });

      // Finalize cutover
      await keyRotation.finalizeCutover(cutoverKeyId);

      const [updated] = await db
        .select()
        .from(groundStationCredentials)
        .where(eq(groundStationCredentials.keyId, cutoverKeyId));

      expect(updated!.status).toBe("REVOKED");
      expect(updated!.revokedAt).toBeDefined();

      const evaluation = keyRotation.evaluateKeyUsability(updated!);
      expect(evaluation.isUsable).toBe(false);
      expect(evaluation.errorCode).toBe("CREDENTIAL_REVOKED");
    });

    it("verifies telemetry signed with envelope-encrypted credentials", async () => {
      const encKeyId = `gs-key-enc-${crypto.randomUUID().slice(0, 8)}`;
      const rawSecret = "envelope-protected-ground-secret-32b!";

      // Encrypt under KMS
      const envelope = await kmsCustody.encryptSecret(rawSecret, {
        stationId,
        keyId: encKeyId,
        purpose: "TELEMETRY_SIGNING",
      });

      // Insert credential with envelope JSON prefixed by 'enc:'
      await db.insert(groundStationCredentials).values({
        groundStationId: stationId,
        keyId: encKeyId,
        secretKey: `enc:${JSON.stringify(envelope)}`,
        status: "ACTIVE",
        expiresAt: new Date(Date.now() + 86400000),
      });

      const dispatchId = `disp-enc-${Date.now()}`;
      const payload = { snr: 18.2, carrierLocked: true };
      const nowIso = new Date().toISOString();
      const nonce = `nonce-enc-${crypto.randomUUID().slice(0, 8)}`;

      // Station signs using rawSecret
      const canon = groundSecurityService.buildCanonicalString(dispatchId, 1, nowIso, nonce, payload);
      const sig = groundSecurityService.generateSignature(rawSecret, canon);

      // OrbitMesh verifies: automatically envelope-decrypts secret via KMS and validates signature
      const result = await groundSecurityService.verifyTelemetrySignature(
        { keyId: encKeyId, signature: sig, nonce, timestamp: nowIso },
        dispatchId,
        1,
        payload
      );

      expect(result.isValid).toBe(true);
      expect(result.keyId).toBe(encKeyId);
    });
  });

  // =========================================================================
  // 5. Secure Abort Channel (Out-of-band Priority Execution)
  // =========================================================================
  describe("5. Secure Abort Channel: Out-of-band Priority Execution", () => {
    const officerId = "safety-officer-007";
    const officerKey = "safety-officer-emergency-key-32bytes-len!";

    beforeEach(() => {
      secureAbort.registerSafetyOfficer({
        officerId,
        role: "SAFETY_OFFICER",
        secretKey: officerKey,
        active: true,
      });
    });

    it("authenticates and executes out-of-band emergency abort, silencing RF carrier", async () => {
      const dispatchId = `disp-abort-${Date.now()}`;
      const context: DispatchContext = {
        dispatchId,
        attemptNumber: 1,
        idempotencyKey: `idemp-abort-${Date.now()}`,
        correlationId: `corr-abort-${Date.now()}`,
        providerId: "default-provider",
        stationCode: "SEC-STATION",
      };

      const directiveBase = {
        directiveId: `DIR-${Date.now()}`,
        dispatchId,
        reservationId,
        satelliteId: satId,
        stationCode: "SEC-STATION",
        emergencyReason: "COLLISION_AVOIDANCE" as const,
        immediateRfInhibit: true,
        sequenceCounter: 1,
        issuedAt: new Date().toISOString(),
        authorizedBy: {
          officerId,
          role: "SAFETY_OFFICER" as const,
        },
      };

      const signature = secureAbort.signDirective(directiveBase, officerKey);
      const directive = { ...directiveBase, signature };

      const receipt = await secureAbort.processAbortDirective(directive, context);

      expect(receipt.carrierSilenced).toBe(true);
      expect(receipt.directiveId).toBe(directiveBase.directiveId);
      expect(receipt.officerId).toBe(officerId);
      expect(receipt.latencyMs).toBeLessThan(1000); // Strict execution latency bound
      expect(receipt.executionProof).toBeDefined();

      // Verify reservation interlock state transitioned to ABORT_CONFIRMED
      const [updatedRes] = await db
        .select()
        .from(reservations)
        .where(eq(reservations.id, reservationId));

      expect(updatedRes!.executionInterlock).toBe("ABORT_CONFIRMED");
    });

    it("rejects abort directive from unregistered or unauthorized officer", async () => {
      const directiveBase = {
        directiveId: `DIR-ROGUE-${Date.now()}`,
        dispatchId: "disp-rogue",
        reservationId,
        satelliteId: satId,
        stationCode: "SEC-STATION",
        emergencyReason: "UNAUTHORIZED_TRANSMISSION" as const,
        immediateRfInhibit: true,
        sequenceCounter: 1,
        issuedAt: new Date().toISOString(),
        authorizedBy: {
          officerId: "unregistered-rogue-actor",
          role: "SAFETY_OFFICER" as const,
        },
      };

      const signature = crypto.createHmac("sha256", "bad-key").update("test").digest("hex");
      const directive = { ...directiveBase, signature };

      const context: DispatchContext = {
        dispatchId: "disp-rogue",
        attemptNumber: 1,
        idempotencyKey: "idemp-rogue",
        correlationId: "corr-rogue",
        providerId: "mock",
        stationCode: "GS",
      };

      await expect(secureAbort.processAbortDirective(directive, context)).rejects.toThrow(
        /officer \[unregistered-rogue-actor\] not registered/
      );
    });

    it("rejects abort directive with sequence counter <= last seen (anti-replay)", async () => {
      const dispatchId = `disp-seq-${Date.now()}`;
      const context: DispatchContext = {
        dispatchId,
        attemptNumber: 1,
        idempotencyKey: "idemp-seq",
        correlationId: "corr-seq",
        providerId: "mock",
        stationCode: "GS",
      };

      // Directive 1: sequence counter = 5
      const directive1Base = {
        directiveId: `DIR-1-${Date.now()}`,
        dispatchId,
        reservationId,
        satelliteId: satId,
        stationCode: "SEC-STATION",
        emergencyReason: "HARDWARE_ANOMALY" as const,
        immediateRfInhibit: true,
        sequenceCounter: 5,
        issuedAt: new Date().toISOString(),
        authorizedBy: { officerId, role: "SAFETY_OFFICER" as const },
      };
      const sig1 = secureAbort.signDirective(directive1Base, officerKey);
      await secureAbort.processAbortDirective({ ...directive1Base, signature: sig1 }, context);

      // Directive 2: replayed sequence counter = 5 (or 4) -> REJECT!
      const directive2Base = {
        ...directive1Base,
        directiveId: `DIR-2-${Date.now()}`,
        sequenceCounter: 5,
        issuedAt: new Date().toISOString(),
      };
      const sig2 = secureAbort.signDirective(directive2Base, officerKey);

      await expect(
        secureAbort.processAbortDirective({ ...directive2Base, signature: sig2 }, context)
      ).rejects.toThrow(/Stale or replayed abort directive/);
    });

    it("rejects abort directive outside narrow timestamp tolerance window (clock skew / delay attack)", async () => {
      const dispatchId = `disp-skew-${Date.now()}`;
      const context: DispatchContext = {
        dispatchId,
        attemptNumber: 1,
        idempotencyKey: "idemp-skew",
        correlationId: "corr-skew",
        providerId: "mock",
        stationCode: "GS",
      };

      // Directive issued 10 seconds ago (tolerance is ±2 seconds)
      const staleTime = new Date(Date.now() - 10000).toISOString();
      const directiveBase = {
        directiveId: `DIR-SKEW-${Date.now()}`,
        dispatchId,
        reservationId,
        satelliteId: satId,
        stationCode: "SEC-STATION",
        emergencyReason: "COLLISION_AVOIDANCE" as const,
        immediateRfInhibit: true,
        sequenceCounter: 1,
        issuedAt: staleTime,
        authorizedBy: { officerId, role: "SAFETY_OFFICER" as const },
      };
      const signature = secureAbort.signDirective(directiveBase, officerKey);

      await expect(
        secureAbort.processAbortDirective({ ...directiveBase, signature }, context)
      ).rejects.toThrow(/Abort directive timestamp outside narrow tolerance window/);
    });

    it("rejects abort directive with tampered cryptographic signature", async () => {
      const dispatchId = `disp-tamper-${Date.now()}`;
      const context: DispatchContext = {
        dispatchId,
        attemptNumber: 1,
        idempotencyKey: "idemp-tamper",
        correlationId: "corr-tamper",
        providerId: "mock",
        stationCode: "GS",
      };

      const directiveBase = {
        directiveId: `DIR-TAMPER-${Date.now()}`,
        dispatchId,
        reservationId,
        satelliteId: satId,
        stationCode: "SEC-STATION",
        emergencyReason: "REGULATORY_INHIBIT" as const,
        immediateRfInhibit: true,
        sequenceCounter: 1,
        issuedAt: new Date().toISOString(),
        authorizedBy: { officerId, role: "SAFETY_OFFICER" as const },
      };

      const validSig = secureAbort.signDirective(directiveBase, officerKey);
      // Tamper signature hex
      const tamperedSig = validSig.slice(0, -2) + (validSig.endsWith("aa") ? "bb" : "aa");

      await expect(
        secureAbort.processAbortDirective({ ...directiveBase, signature: tamperedSig }, context)
      ).rejects.toThrow(/Invalid cryptographic signature/);
    });
  });
});
