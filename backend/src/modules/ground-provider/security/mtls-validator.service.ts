/**
 * Phase 5.8: Workstream 5.8.3 — Production Transport Security & Key Custody
 * Mutual TLS (mTLS) Validator & X.509 CA Trust Chain Manager
 */

import crypto from "crypto";
import { logger } from "../../../config/logger";
import { crlOcspService, CrlOcspService } from "./crl-ocsp.service";

export interface MtlsTrustStoreConfig {
  readonly trustedRoots: string[]; // PEM strings
  readonly trustedIntermediates?: string[]; // PEM strings
  readonly enforceSanMatching?: boolean; // Default true
  readonly checkRevocation?: boolean; // Default true
}

export interface MtlsValidationOptions {
  readonly expectedHostname?: string;
  readonly requiredKeyUsage?: "digitalSignature" | "keyEncipherment";
  readonly validationTime?: Date;
  readonly ocspResponse?: {
    readonly response: Parameters<CrlOcspService["verifyOcspResponse"]>[0];
    readonly expectedNonce: string;
  };
}

export interface MtlsValidationResult {
  readonly isValid: boolean;
  readonly leafSubject?: string;
  readonly leafIssuer?: string;
  readonly leafSerialNumber?: string;
  readonly leafFingerprint256?: string;
  readonly chainDepth: number;
  readonly rootFingerprint256?: string;
  readonly errorCode?:
    | "MALFORMED_CERTIFICATE"
    | "CERT_EXPIRED"
    | "CERT_NOT_YET_VALID"
    | "UNTRUSTED_ROOT"
    | "CHAIN_BROKEN"
    | "SAN_MISMATCH"
    | "KEY_USAGE_INVALID"
    | "REVOKED_CRL"
    | "REVOKED_OCSP"
    | "OCSP_REPLAY_DETECTED";
  readonly errorMessage?: string;
}

export class MtlsValidatorService {
  private readonly rootTrustStore = new Map<string, crypto.X509Certificate>(); // fingerprint256 -> cert
  private readonly intermediateStore = new Map<string, crypto.X509Certificate>(); // fingerprint256 -> cert
  private readonly crlOcsp: CrlOcspService;

  constructor(config?: MtlsTrustStoreConfig, crlOcsp = crlOcspService) {
    this.crlOcsp = crlOcsp;
    if (config) {
      this.loadTrustStore(config);
    }
  }

  /**
   * Load root and intermediate trust anchors into trust store
   */
  public loadTrustStore(config: MtlsTrustStoreConfig): void {
    for (const rootPem of config.trustedRoots) {
      try {
        const cert = new crypto.X509Certificate(rootPem);
        this.rootTrustStore.set(cert.fingerprint256, cert);
      } catch (err) {
        logger.error({ err }, "[mTLS] Failed to parse trusted root certificate");
      }
    }

    if (config.trustedIntermediates) {
      for (const intPem of config.trustedIntermediates) {
        try {
          const cert = new crypto.X509Certificate(intPem);
          this.intermediateStore.set(cert.fingerprint256, cert);
        } catch (err) {
          logger.error({ err }, "[mTLS] Failed to parse trusted intermediate certificate");
        }
      }
    }

    logger.info(
      { roots: this.rootTrustStore.size, intermediates: this.intermediateStore.size },
      "[mTLS] Loaded X.509 Trust Store"
    );
  }

  /**
   * Add a single root CA anchor
   */
  public addRootAnchor(rootPem: string): void {
    const cert = new crypto.X509Certificate(rootPem);
    this.rootTrustStore.set(cert.fingerprint256, cert);
  }

  /**
   * Add a single intermediate CA anchor
   */
  public addIntermediateAnchor(intPem: string): void {
    const cert = new crypto.X509Certificate(intPem);
    this.intermediateStore.set(cert.fingerprint256, cert);
  }

  /**
   * Clear all trust anchors
   */
  public clearTrustStore(): void {
    this.rootTrustStore.clear();
    this.intermediateStore.clear();
  }

  /**
   * Validate a presented client or server certificate and optional chain bundle
   */
  public validateCertificate(
    leafPem: string,
    chainPems: string[] = [],
    options?: MtlsValidationOptions
  ): MtlsValidationResult {
    const checkTime = options?.validationTime ?? new Date();

    // 1. Parse Leaf Certificate
    let leafCert: crypto.X509Certificate;
    try {
      leafCert = new crypto.X509Certificate(leafPem);
    } catch (err) {
      return {
        isValid: false,
        chainDepth: 0,
        errorCode: "MALFORMED_CERTIFICATE",
        errorMessage: `Failed to parse leaf certificate: ${(err as Error).message}`,
      };
    }

    // 2. Temporal Validity Check
    const validFrom = new Date(leafCert.validFrom);
    const validTo = new Date(leafCert.validTo);
    if (checkTime < validFrom) {
      return {
        isValid: false,
        chainDepth: 1,
        leafSubject: leafCert.subject,
        leafSerialNumber: leafCert.serialNumber,
        errorCode: "CERT_NOT_YET_VALID",
        errorMessage: `Certificate not valid until ${validFrom.toISOString()}`,
      };
    }
    if (checkTime > validTo) {
      return {
        isValid: false,
        chainDepth: 1,
        leafSubject: leafCert.subject,
        leafSerialNumber: leafCert.serialNumber,
        errorCode: "CERT_EXPIRED",
        errorMessage: `Certificate expired on ${validTo.toISOString()}`,
      };
    }

    // 3. Subject Alternative Name (SAN) & Hostname Matching
    if (options?.expectedHostname) {
      const match = leafCert.checkHost(options.expectedHostname);
      if (!match) {
        return {
          isValid: false,
          chainDepth: 1,
          leafSubject: leafCert.subject,
          leafSerialNumber: leafCert.serialNumber,
          errorCode: "SAN_MISMATCH",
          errorMessage: `Hostname [${options.expectedHostname}] does not match certificate SANs (${leafCert.subjectAltName ?? "none"})`,
        };
      }
    }

    // 4. Key Usage Constraints
    if (options?.requiredKeyUsage) {
      if (leafCert.keyUsage && leafCert.keyUsage.length > 0) {
        // e.g. "Digital Signature, Key Encipherment"
        const usages = leafCert.keyUsage.map((u) => u.toLowerCase().replace(/[\s_]/g, ""));
        const target = options.requiredKeyUsage.toLowerCase().replace(/[\s_]/g, "");
        if (!usages.some((u) => u.includes(target))) {
          return {
            isValid: false,
            chainDepth: 1,
            leafSubject: leafCert.subject,
            errorCode: "KEY_USAGE_INVALID",
            errorMessage: `Certificate keyUsage does not satisfy required [${options.requiredKeyUsage}]`,
          };
        }
      }
    }

    // 5. Revocation Verification (CRL)
    const crlStatus = this.crlOcsp.checkCrl(leafCert, checkTime);
    if (crlStatus.isRevoked) {
      return {
        isValid: false,
        chainDepth: 1,
        leafSubject: leafCert.subject,
        leafSerialNumber: leafCert.serialNumber,
        errorCode: "REVOKED_CRL",
        errorMessage: `Certificate serial ${leafCert.serialNumber} revoked in CRL (reason: ${crlStatus.entry?.reason ?? "UNSPECIFIED"})`,
      };
    }

    // 6. Revocation Verification (OCSP Stapling / Response)
    if (options?.ocspResponse) {
      const ocspCheck = this.crlOcsp.verifyOcspResponse(
        options.ocspResponse.response,
        options.ocspResponse.expectedNonce,
        checkTime
      );
      if (!ocspCheck.isValid) {
        return {
          isValid: false,
          chainDepth: 1,
          leafSubject: leafCert.subject,
          leafSerialNumber: leafCert.serialNumber,
          errorCode: "OCSP_REPLAY_DETECTED",
          errorMessage: ocspCheck.reason ?? "OCSP response invalid or replay detected",
        };
      }
      if (ocspCheck.status === "REVOKED") {
        return {
          isValid: false,
          chainDepth: 1,
          leafSubject: leafCert.subject,
          leafSerialNumber: leafCert.serialNumber,
          errorCode: "REVOKED_OCSP",
          errorMessage: `Certificate reported REVOKED by OCSP: ${ocspCheck.reason}`,
        };
      }
    }

    // 7. Chain of Trust Validation
    // Parse any supplied intermediate bundle
    const intermediateCerts: crypto.X509Certificate[] = [];
    for (const pem of chainPems) {
      try {
        intermediateCerts.push(new crypto.X509Certificate(pem));
      } catch (err) {
        return {
          isValid: false,
          chainDepth: 1,
          errorCode: "MALFORMED_CERTIFICATE",
          errorMessage: `Malformed intermediate certificate in bundle: ${(err as Error).message}`,
        };
      }
    }

    // Also include pre-configured intermediates in the resolution pool
    const pool = [...intermediateCerts, ...Array.from(this.intermediateStore.values())];

    // Build chain from leaf up to root
    let currentCert = leafCert;
    let chainDepth = 1;
    let verifiedToRoot = false;
    let rootCert: crypto.X509Certificate | undefined;

    // Direct Root Anchor check (self-signed leaf that is an explicitly trusted root)
    if (this.rootTrustStore.has(leafCert.fingerprint256)) {
      if (leafCert.verify(leafCert.publicKey)) {
        return {
          isValid: true,
          leafSubject: leafCert.subject,
          leafIssuer: leafCert.issuer,
          leafSerialNumber: leafCert.serialNumber,
          leafFingerprint256: leafCert.fingerprint256,
          chainDepth: 1,
          rootFingerprint256: leafCert.fingerprint256,
        };
      }
    }

    // Maximum chain traversal depth 10
    while (chainDepth < 10 && !verifiedToRoot) {
      // Check if currentCert's issuer is one of our trusted roots
      let matchedRoot: crypto.X509Certificate | undefined;
      for (const root of this.rootTrustStore.values()) {
        if (currentCert.issuer === root.subject && currentCert.verify(root.publicKey)) {
          matchedRoot = root;
          break;
        }
      }

      if (matchedRoot) {
        verifiedToRoot = true;
        rootCert = matchedRoot;
        chainDepth++;
        break;
      }

      // Otherwise look for parent in intermediate pool
      let parentIntermediate: crypto.X509Certificate | undefined;
      for (const candidate of pool) {
        if (currentCert.issuer === candidate.subject && currentCert.verify(candidate.publicKey)) {
          parentIntermediate = candidate;
          break;
        }
      }

      if (!parentIntermediate) {
        // Cannot find valid parent certificate
        return {
          isValid: false,
          chainDepth,
          leafSubject: leafCert.subject,
          leafIssuer: leafCert.issuer,
          errorCode: "CHAIN_BROKEN",
          errorMessage: `Chain broken: unable to find verified issuing CA for subject [${currentCert.subject}]`,
        };
      }

      // Check intermediate temporal validity
      if (checkTime < new Date(parentIntermediate.validFrom) || checkTime > new Date(parentIntermediate.validTo)) {
        return {
          isValid: false,
          chainDepth,
          errorCode: "CERT_EXPIRED",
          errorMessage: `Intermediate CA [${parentIntermediate.subject}] is outside its validity window`,
        };
      }

      currentCert = parentIntermediate;
      chainDepth++;
    }

    if (!verifiedToRoot || !rootCert) {
      return {
        isValid: false,
        chainDepth,
        leafSubject: leafCert.subject,
        leafIssuer: leafCert.issuer,
        errorCode: "UNTRUSTED_ROOT",
        errorMessage: "Chain did not terminate at an anchored Root CA in the Trust Store",
      };
    }

    return {
      isValid: true,
      leafSubject: leafCert.subject,
      leafIssuer: leafCert.issuer,
      leafSerialNumber: leafCert.serialNumber,
      leafFingerprint256: leafCert.fingerprint256,
      chainDepth,
      rootFingerprint256: rootCert.fingerprint256,
    };
  }
}

export const mtlsValidatorService = new MtlsValidatorService();
