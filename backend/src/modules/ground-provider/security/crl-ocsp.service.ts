/**
 * Phase 5.8: Workstream 5.8.3 — Production Transport Security & Key Custody
 * Certificate Revocation List (CRL) and Online Certificate Status Protocol (OCSP) Service
 */

import crypto from "crypto";
import { logger } from "../../../config/logger";

export interface CrlEntry {
  readonly serialNumber: string;
  readonly revocationDate: Date;
  readonly reason?: "KEY_COMPROMISE" | "CA_COMPROMISE" | "AFFILIATION_CHANGED" | "SUPERSEDED" | "CESSATION_OF_OPERATION" | "UNSPECIFIED";
}

export interface CrlDistribution {
  readonly issuer: string;
  readonly thisUpdate: Date;
  readonly nextUpdate: Date;
  readonly revokedSerials: Map<string, CrlEntry>; // normalized hex serial -> CrlEntry
}

export interface OcspResponse {
  readonly status: "GOOD" | "REVOKED" | "UNKNOWN";
  readonly serialNumber: string;
  readonly producedAt: Date;
  readonly thisUpdate: Date;
  readonly nextUpdate?: Date | undefined;
  readonly revocationTime?: Date | undefined;
  readonly revocationReason?: string | undefined;
  readonly nonce: string;
  readonly responderId: string;
  readonly signature: string;
}

export type CertificateLifecycleState = "VALID" | "EXPIRING_SOON" | "EXPIRED" | "REVOKED";

export interface CertificateLifecycleStatus {
  readonly state: CertificateLifecycleState;
  readonly serialNumber: string;
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly daysUntilExpiration: number;
  readonly isRevoked: boolean;
  readonly revocationSource?: "CRL" | "OCSP" | undefined;
  readonly revocationReason?: string | undefined;
}

export class CrlOcspService {
  public static readonly DEFAULT_EXPIRING_SOON_DAYS = 30;
  private readonly crlCache = new Map<string, CrlDistribution>(); // issuer -> CrlDistribution
  private readonly ocspResponderStore = new Map<string, Omit<OcspResponse, "nonce" | "signature">>(); // serial -> status

  /**
   * Normalize serial number format (removes colons and lowercases)
   */
  public normalizeSerial(serial: string): string {
    return serial.replace(/[:\s]/g, "").toLowerCase();
  }

  /**
   * Register or update a CRL distribution for an issuing CA
   */
  public registerCrl(crl: {
    issuer: string;
    thisUpdate: Date;
    nextUpdate: Date;
    revoked: Array<{
      serialNumber: string;
      revocationDate: Date;
      reason?: CrlEntry["reason"];
    }>;
  }): void {
    const revokedMap = new Map<string, CrlEntry>();
    for (const r of crl.revoked) {
      const norm = this.normalizeSerial(r.serialNumber);
      revokedMap.set(norm, {
        serialNumber: norm,
        revocationDate: r.revocationDate,
        reason: r.reason ?? "UNSPECIFIED",
      });
    }

    this.crlCache.set(crl.issuer, {
      issuer: crl.issuer,
      thisUpdate: crl.thisUpdate,
      nextUpdate: crl.nextUpdate,
      revokedSerials: revokedMap,
    });

    logger.info(
      { issuer: crl.issuer, revokedCount: revokedMap.size },
      "[CRL_OCSP] Registered CRL distribution"
    );
  }

  /**
   * Check if a certificate is revoked according to registered CRLs
   */
  public checkCrl(cert: crypto.X509Certificate, checkTime = new Date()): { isRevoked: boolean; entry?: CrlEntry } {
    const serial = this.normalizeSerial(cert.serialNumber);
    
    // Look up CRL by issuer
    const crl = this.crlCache.get(cert.issuer);
    if (!crl) {
      // No CRL registered for this issuer - check fallback search across all cached CRLs
      for (const cachedCrl of this.crlCache.values()) {
        const entry = cachedCrl.revokedSerials.get(serial);
        if (entry && entry.revocationDate <= checkTime) {
          return { isRevoked: true, entry };
        }
      }
      return { isRevoked: false };
    }

    // Check CRL freshness
    if (checkTime > crl.nextUpdate) {
      logger.warn({ issuer: crl.issuer }, "[CRL_OCSP] Cached CRL is past nextUpdate; evaluating with caution");
    }

    const entry = crl.revokedSerials.get(serial);
    if (entry && entry.revocationDate <= checkTime) {
      return { isRevoked: true, entry };
    }

    return { isRevoked: false };
  }

  /**
   * Configure simulated OCSP responder state for a certificate
   */
  public setOcspStatus(
    serialNumber: string,
    status: "GOOD" | "REVOKED" | "UNKNOWN",
    options?: {
      revocationTime?: Date;
      revocationReason?: string;
      responderId?: string;
    }
  ): void {
    const norm = this.normalizeSerial(serialNumber);
    this.ocspResponderStore.set(norm, {
      status,
      serialNumber: norm,
      producedAt: new Date(),
      thisUpdate: new Date(),
      revocationTime: options?.revocationTime,
      revocationReason: options?.revocationReason,
      responderId: options?.responderId ?? "ocsp.groundnetwork.orbitmesh.internal",
    });
  }

  /**
   * Generate signed OCSP response for a client request (OCSP Stapling / Request-Response)
   */
  public generateOcspResponse(
    cert: crypto.X509Certificate,
    clientNonce: string,
    responderPrivateKeyPem?: string
  ): OcspResponse {
    const serial = this.normalizeSerial(cert.serialNumber);
    const ocspInfo = this.ocspResponderStore.get(serial) ?? {
      status: "GOOD",
      serialNumber: serial,
      producedAt: new Date(),
      thisUpdate: new Date(),
      responderId: "ocsp.groundnetwork.orbitmesh.internal",
    };

    const payload = `${ocspInfo.status}|${serial}|${clientNonce}|${ocspInfo.thisUpdate.toISOString()}`;
    let signature = "";
    if (responderPrivateKeyPem) {
      signature = crypto
        .createSign("sha256")
        .update(payload)
        .sign(responderPrivateKeyPem, "hex");
    } else {
      signature = crypto.createHash("sha256").update(payload).digest("hex");
    }

    return {
      ...ocspInfo,
      nonce: clientNonce,
      signature,
    };
  }

  /**
   * Verify an OCSP response against request nonce and status
   */
  public verifyOcspResponse(
    response: OcspResponse,
    expectedNonce: string,
    checkTime = new Date()
  ): { isValid: boolean; status: "GOOD" | "REVOKED" | "UNKNOWN"; reason?: string } {
    if (response.nonce !== expectedNonce) {
      return {
        isValid: false,
        status: "UNKNOWN",
        reason: "OCSP nonce mismatch (replay protection failure)",
      };
    }

    if (response.status === "REVOKED") {
      return {
        isValid: true,
        status: "REVOKED",
        reason: response.revocationReason ?? "Certificate revoked by issuing CA",
      };
    }

    if (response.status === "UNKNOWN") {
      return {
        isValid: true,
        status: "UNKNOWN",
        reason: "OCSP responder returned UNKNOWN status",
      };
    }

    return { isValid: true, status: "GOOD" };
  }

  /**
   * Evaluate full certificate lifecycle state (VALID, EXPIRING_SOON, EXPIRED, REVOKED)
   */
  public evaluateLifecycle(
    cert: crypto.X509Certificate,
    checkTime = new Date(),
    expiringSoonDays = CrlOcspService.DEFAULT_EXPIRING_SOON_DAYS
  ): CertificateLifecycleStatus {
    const serial = this.normalizeSerial(cert.serialNumber);
    const validFrom = new Date(cert.validFrom);
    const validTo = new Date(cert.validTo);

    // 1. Check CRL Revocation
    const crlCheck = this.checkCrl(cert, checkTime);
    if (crlCheck.isRevoked) {
      return {
        state: "REVOKED",
        serialNumber: serial,
        validFrom,
        validTo,
        daysUntilExpiration: 0,
        isRevoked: true,
        revocationSource: "CRL",
        revocationReason: crlCheck.entry?.reason,
      };
    }

    // 2. Check OCSP Revocation
    const ocspInfo = this.ocspResponderStore.get(serial);
    if (ocspInfo && ocspInfo.status === "REVOKED") {
      return {
        state: "REVOKED",
        serialNumber: serial,
        validFrom,
        validTo,
        daysUntilExpiration: 0,
        isRevoked: true,
        revocationSource: "OCSP",
        revocationReason: ocspInfo.revocationReason,
      };
    }

    // 3. Check Expiration
    if (checkTime > validTo || checkTime < validFrom) {
      return {
        state: "EXPIRED",
        serialNumber: serial,
        validFrom,
        validTo,
        daysUntilExpiration: 0,
        isRevoked: false,
      };
    }

    // 4. Check Expiring Soon
    const msPerDay = 86400000;
    const daysUntilExpiration = Math.max(0, Math.floor((validTo.getTime() - checkTime.getTime()) / msPerDay));
    if (daysUntilExpiration <= expiringSoonDays) {
      return {
        state: "EXPIRING_SOON",
        serialNumber: serial,
        validFrom,
        validTo,
        daysUntilExpiration,
        isRevoked: false,
      };
    }

    return {
      state: "VALID",
      serialNumber: serial,
      validFrom,
      validTo,
      daysUntilExpiration,
      isRevoked: false,
    };
  }

  /**
   * Reset caches (useful for clean test isolation)
   */
  public clear(): void {
    this.crlCache.clear();
    this.ocspResponderStore.clear();
  }
}

export const crlOcspService = new CrlOcspService();
