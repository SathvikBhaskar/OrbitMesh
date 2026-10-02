import {
  IGroundStationProviderAdapter,
  DispatchContext,
  RfRequirements,
  CapabilityValidationResult,
  StagedPassReceipt,
  ArmedPassReceipt,
  PassAbortReceipt,
  PassStatusSnapshot,
} from "../provider.types";
import { DispatchManifest } from "../../execution/execution.types";
import { logger } from "../../../config/logger";

export interface MockProviderOptions {
  simulateStageTimeout?: boolean;
  simulateStageRejection?: boolean;
  stageRejectionReason?: string;
  simulateAbortTimeout?: boolean;
  supportedBands?: string[];
  maxDataRateMbps?: number;
}

export class MockGroundStationProviderAdapter
  implements IGroundStationProviderAdapter
{
  public readonly providerId: string;
  public options: MockProviderOptions = {};

  // Internal state tracking external provider's recorded passes
  private passes = new Map<
    string,
    {
      dispatchId: string;
      providerDispatchRef: string;
      state: "STAGED" | "ARMED" | "TRACKING" | "TERMINATED";
      stagedAt: Date;
      armedAt?: Date;
      abortedAt?: Date;
      bytesTransferred: number;
      idempotencyKey: string;
    }
  >();

  constructor(providerId: string = "mock-provider", options: MockProviderOptions = {}) {
    this.providerId = providerId;
    this.options = {
      supportedBands: ["S_BAND", "X_BAND"],
      maxDataRateMbps: 500,
      ...options,
    };
  }

  async stagePass(
    manifest: DispatchManifest,
    context: DispatchContext
  ): Promise<StagedPassReceipt> {
    const { dispatchId, idempotencyKey } = context;

    // Idempotent duplicate check: return existing receipt if already staged
    const existing = this.passes.get(dispatchId);
    if (existing) {
      logger.info({ dispatchId }, "[MockProvider] Existing pass returned idempotently");
      return {
        providerDispatchRef: existing.providerDispatchRef,
        stagedAt: existing.stagedAt,
        stationStatus: "READY",
        rawProviderResponse: { reused: true, status: existing.state },
      };
    }

    // Physical rejection simulation
    if (this.options.simulateStageRejection) {
      throw new Error(this.options.stageRejectionReason || "PROVIDER_CAPABILITY_REJECTED");
    }

    // Create internal record
    const providerRef = `mock-ref-${dispatchId}`;
    const stagedRecord = {
      dispatchId,
      providerDispatchRef: providerRef,
      state: "STAGED" as const,
      stagedAt: new Date(),
      bytesTransferred: 0,
      idempotencyKey,
    };
    this.passes.set(dispatchId, stagedRecord);

    // Timeout / ambiguous outcome simulation:
    // Provider saved pass, but response drops before reaching caller!
    if (this.options.simulateStageTimeout) {
      logger.warn({ dispatchId }, "[MockProvider] Simulating network drop after provider accepted stage");
      throw new Error("HTTP_PROVIDER_TIMEOUT");
    }

    return {
      providerDispatchRef: providerRef,
      stagedAt: stagedRecord.stagedAt,
      stationStatus: "READY",
      rawProviderResponse: { acknowledged: true, providerRef },
    };
  }

  async armPass(
    dispatchId: string,
    context: DispatchContext
  ): Promise<ArmedPassReceipt> {
    const record = this.passes.get(dispatchId);
    if (!record) {
      throw new Error(`[MockProvider] Cannot arm unknown dispatch ${dispatchId}`);
    }

    record.state = "ARMED";
    record.armedAt = new Date();

    return {
      armedAt: record.armedAt,
      trackingConfigured: true,
      rawProviderResponse: { trackingConfigured: true, state: "ARMED" },
    };
  }

  async abortPass(
    dispatchId: string,
    reason: string,
    context: DispatchContext
  ): Promise<PassAbortReceipt> {
    if (this.options.simulateAbortTimeout) {
      logger.warn({ dispatchId }, "[MockProvider] Simulating abort command timeout (ambiguous outcome)");
      throw new Error("ABORT_TRANSPORT_TIMEOUT");
    }

    const record = this.passes.get(dispatchId);
    if (record) {
      record.state = "TERMINATED";
      record.abortedAt = new Date();
    }

    return {
      confirmedAt: new Date(),
      rfCarrierSilenced: true,
      rawProviderResponse: { silenced: true, reason },
    };
  }

  async pollPassStatus(
    dispatchId: string,
    context: DispatchContext
  ): Promise<PassStatusSnapshot> {
    const record = this.passes.get(dispatchId);
    if (!record) {
      return {
        state: "UNKNOWN",
        carrierLocked: false,
        bytesRecorded: 0,
      };
    }

    return {
      state: record.state,
      carrierLocked: record.state === "ARMED" || record.state === "TRACKING",
      bytesRecorded: record.bytesTransferred,
      lastContactAt: record.stagedAt,
    };
  }

  async validateCapabilities(
    stationId: string,
    requirements: RfRequirements
  ): Promise<CapabilityValidationResult> {
    const supported = this.options.supportedBands || ["S_BAND", "X_BAND"];
    const maxRate = this.options.maxDataRateMbps || 500;

    const bandOk = supported.includes(requirements.frequencyBand);
    const rateOk = requirements.dataRateMbps <= maxRate;

    return {
      isCompatible: bandOk && rateOk,
      unsupportedBands: bandOk ? [] : [requirements.frequencyBand],
      maxDataRateFeasible: rateOk,
      reason: !bandOk
        ? `Band ${requirements.frequencyBand} not supported`
        : !rateOk
        ? `Data rate ${requirements.dataRateMbps}Mbps exceeds max ${maxRate}Mbps`
        : undefined,
    };
  }

  public reset(): void {
    this.passes.clear();
    this.options = {};
  }
}
