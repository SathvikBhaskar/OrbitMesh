import { IGroundStationProviderAdapter } from "./provider.types";
import { MockGroundStationProviderAdapter } from "./adapters/mock-provider.adapter";
import { AwsGroundStationProviderAdapter } from "./adapters/aws-ground-station.adapter";
import { SleGroundStationProviderAdapter } from "./adapters/sle/sle-provider.adapter";
import {
  ProviderCertificationReceipt,
  ProviderNotCertifiedError,
} from "./certification/certification.types";
import { providerCertificationHarness } from "./certification/certification-harness.service";
import { logger } from "../../config/logger";

export {
  ProviderNotCertifiedError,
  AwsGroundStationProviderAdapter,
  SleGroundStationProviderAdapter,
};

export class ProviderRegistry {
  private adapters = new Map<string, IGroundStationProviderAdapter>();
  private certifications = new Map<string, ProviderCertificationReceipt>();

  constructor() {
    // Register default mock provider with baseline valid certification
    const defaultAdapter = new MockGroundStationProviderAdapter("default-provider");
    this.adapters.set(defaultAdapter.providerId, defaultAdapter);

    // Seed default internal certification receipt
    this.certifications.set("default-provider", {
      certificationRunId: "CERT-SYSTEM-DEFAULT",
      providerId: "default-provider",
      adapterVersion: "1.0.0",
      contractVersion: "5.8.0",
      certificationSuiteVersion: "5.8.1",
      certifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 86400000),
      environment: "PRODUCTION",
      isCertified: true,
      resultsDigest: "system-bootstrap-digest",
      summary: {
        semantic: true,
        distributed: true,
        security: true,
        safety: true,
        totalAssertions: 16,
        passedAssertions: 16,
      },
      layerResults: {} as any,
      signature: "system-bootstrap-sig",
    });
  }

  /**
   * Register a provider adapter. By default, it is UNCERTIFIED unless a valid receipt is provided
   * or options.autoCertify is explicitly enabled (e.g. for backward-compatible test harnesses).
   */
  registerAdapter(
    adapter: IGroundStationProviderAdapter,
    options: {
      certificationReceipt?: ProviderCertificationReceipt;
      autoCertify?: boolean;
    } = {}
  ): void {
    this.adapters.set(adapter.providerId, adapter);

    if (options.certificationReceipt) {
      this.certifyAdapter(adapter.providerId, options.certificationReceipt);
    } else if (options.autoCertify) {
      this.certifications.set(adapter.providerId, {
        certificationRunId: `CERT-AUTO-${Date.now()}`,
        providerId: adapter.providerId,
        adapterVersion: "1.0.0",
        contractVersion: "5.8.0",
        certificationSuiteVersion: "5.8.1",
        certifiedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        environment: "TEST",
        isCertified: true,
        resultsDigest: "auto-test-digest",
        summary: {
          semantic: true,
          distributed: true,
          security: true,
          safety: true,
          totalAssertions: 16,
          passedAssertions: 16,
        },
        layerResults: {} as any,
        signature: "auto-test-sig",
      });
    } else {
      // Any other registration is uncertified by default!
      this.certifications.delete(adapter.providerId);
      logger.info(
        { providerId: adapter.providerId },
        "[PROVIDER_REGISTRY] Registered adapter in UNCERTIFIED state. Production dispatches disabled."
      );
    }
  }

  /**
   * Authoritatively ingest a signed certification receipt from the harness
   */
  certifyAdapter(providerId: string, receipt: ProviderCertificationReceipt): void {
    if (!this.adapters.has(providerId)) {
      throw new Error(`Cannot certify unknown provider [${providerId}]`);
    }

    if (receipt.providerId !== providerId) {
      throw new Error(
        `Certification provider mismatch: receipt [${receipt.providerId}] !== target [${providerId}]`
      );
    }

    // Verify receipt validity (signature, expiration, contract version)
    const verification = providerCertificationHarness.verifyReceipt(receipt);
    if (!verification.isValid) {
      throw new ProviderNotCertifiedError(
        `Certification rejected for provider [${providerId}]: ${verification.reason}`
      );
    }

    this.certifications.set(providerId, receipt);
    logger.info(
      {
        providerId,
        certificationRunId: receipt.certificationRunId,
        expiresAt: receipt.expiresAt,
      },
      "[PROVIDER_REGISTRY] Provider successfully certified. Production dispatches enabled."
    );
  }

  /**
   * Check if a provider has active, valid certification
   */
  isCertified(providerId: string): boolean {
    const receipt = this.certifications.get(providerId);
    if (!receipt || !receipt.isCertified) {
      return false;
    }
    if (new Date(receipt.expiresAt).getTime() < Date.now()) {
      return false;
    }
    return true;
  }

  /**
   * Production Dispatch Enforcement Gate:
   * Throws ProviderNotCertifiedError if provider is not certified
   */
  assertCertified(providerId: string): void {
    if (!this.adapters.has(providerId)) {
      throw new ProviderNotCertifiedError(
        `Provider [${providerId}] is not registered in the provider registry.`
      );
    }

    const receipt = this.certifications.get(providerId);
    if (!receipt) {
      throw new ProviderNotCertifiedError(
        `Provider [${providerId}] has NOT completed the 4-layer certification suite and cannot receive production dispatches.`
      );
    }

    if (!receipt.isCertified) {
      throw new ProviderNotCertifiedError(
        `Provider [${providerId}] failed certification and cannot receive production dispatches.`
      );
    }

    if (new Date(receipt.expiresAt).getTime() < Date.now()) {
      throw new ProviderNotCertifiedError(
        `Provider [${providerId}] certification expired on ${new Date(receipt.expiresAt).toISOString()}. Recertification required.`
      );
    }
  }

  getAdapter(
    providerId: string,
    options: { requireCertified?: boolean } = {}
  ): IGroundStationProviderAdapter {
    if (options.requireCertified) {
      this.assertCertified(providerId);
    }

    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw new Error(`Ground station provider adapter [${providerId}] not found in registry`);
    }
    return adapter;
  }

  getCertificationReceipt(providerId: string): ProviderCertificationReceipt | undefined {
    return this.certifications.get(providerId);
  }

  hasAdapter(providerId: string): boolean {
    return this.adapters.has(providerId);
  }
}

export const providerRegistry = new ProviderRegistry();
