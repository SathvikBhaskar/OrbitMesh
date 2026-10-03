/**
 * Phase 5.8: Workstream 5.8.4 — Hardware-in-the-Loop (HIL) & Virtual Ground Station (VGS)
 * Virtual Ground Station (VGS) Provider Adapter implementing canonical IGroundStationProviderAdapter
 */

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
import { VirtualGroundStation, VgsPassConfig } from "./virtual-ground-station";
import { logger } from "../../../config/logger";

export interface VgsAdapterOptions {
  supportedBands?: Array<"S_BAND" | "X_BAND" | "KA_BAND" | "UHF" | "VHF">;
  maxDataRateMbps?: number;
  vgsInstance?: VirtualGroundStation;
  simulateTimeout?: boolean;
}

export class VgsGroundStationProviderAdapter implements IGroundStationProviderAdapter {
  public readonly providerId: string;
  public readonly vgs: VirtualGroundStation;
  private readonly supportedBands: string[];
  private readonly maxDataRateMbps: number;
  private simulateTimeout = false;

  // Track active passes for idempotency
  private activeDispatches = new Map<
    string,
    {
      manifest: DispatchManifest;
      stagedAt: Date;
      armedAt?: Date;
      abortedAt?: Date;
      idempotencyKey: string;
    }
  >();

  constructor(providerId = "vgs-sdr-provider", options: VgsAdapterOptions = {}) {
    this.providerId = providerId;
    this.vgs = options.vgsInstance ?? new VirtualGroundStation(`VGS-${providerId}`);
    this.supportedBands = options.supportedBands ?? ["S_BAND", "X_BAND"];
    this.maxDataRateMbps = options.maxDataRateMbps ?? 600;
    this.simulateTimeout = options.simulateTimeout ?? false;
  }

  public setSimulateTimeout(simulate: boolean): void {
    this.simulateTimeout = simulate;
  }

  /**
   * Stage pass on the Virtual Ground Station
   */
  async stagePass(manifest: DispatchManifest, context: DispatchContext): Promise<StagedPassReceipt> {
    const { dispatchId, idempotencyKey } = context;

    // 1. Idempotency Check
    const existing = this.activeDispatches.get(dispatchId);
    if (existing) {
      logger.info({ dispatchId }, "[VgsAdapter] Existing pass returned idempotently");
      return {
        providerDispatchRef: `vgs-ref-${dispatchId}`,
        stagedAt: existing.stagedAt,
        stationStatus: "READY",
        rawProviderResponse: {
          reused: true,
          vgsStationCode: this.vgs.stationCode,
        },
      };
    }

    // 2. Timeout Simulation (for harness ambiguous outcome test)
    if (this.simulateTimeout) {
      logger.warn({ dispatchId }, "[VgsAdapter] Simulating network drop after VGS accepted stage");
      throw new Error("HTTP_PROVIDER_TIMEOUT");
    }

    // 3. Configure Virtual Ground Station hardware
    const aosDate = new Date(manifest.window.aos);
    const losDate = new Date(manifest.window.los);
    const vgsConfig: VgsPassConfig = {
      dispatchId,
      satelliteId: manifest.satelliteId,
      stationCode: context.stationCode,
      aosTime: aosDate,
      losTime: losDate,
      scid: 101,
      vcid: 1,
    };
    this.vgs.stagePass(vgsConfig);

    const stagedAt = new Date();
    this.activeDispatches.set(dispatchId, {
      manifest,
      stagedAt,
      idempotencyKey,
    });

    return {
      providerDispatchRef: `vgs-ref-${dispatchId}`,
      stagedAt,
      stationStatus: "READY",
      rawProviderResponse: {
        vgsStationCode: this.vgs.stationCode,
        configuredAos: aosDate.toISOString(),
        configuredLos: losDate.toISOString(),
      },
    };
  }

  /**
   * Arm tracking antenna and SDR Doppler receiver
   */
  async armPass(dispatchId: string, context: DispatchContext): Promise<ArmedPassReceipt> {
    const existing = this.activeDispatches.get(dispatchId);
    if (!existing) {
      throw new Error(`Cannot arm: pass [${dispatchId}] not found in VGS`);
    }

    this.vgs.armPass(dispatchId);
    existing.armedAt = new Date();

    return {
      armedAt: existing.armedAt,
      trackingConfigured: true,
      rawProviderResponse: {
        vgsStationCode: this.vgs.stationCode,
        sdrArmed: true,
        dopplerAfcEngaged: true,
      },
    };
  }

  /**
   * Poll live physical telemetry snapshot from the Virtual Ground Station
   */
  async pollPassStatus(dispatchId: string, context: DispatchContext): Promise<PassStatusSnapshot> {
    const existing = this.activeDispatches.get(dispatchId);
    if (!existing) {
      return {
        state: "UNKNOWN",
        carrierLocked: false,
        bytesRecorded: 0,
      };
    }

    const vgsSnapshot = this.vgs.getSnapshot();

    return {
      state: vgsSnapshot.state,
      carrierLocked: vgsSnapshot.carrierLocked,
      bytesRecorded: vgsSnapshot.bytesRecorded,
      snrDb: vgsSnapshot.snrDb,
      lastContactAt: vgsSnapshot.lastTelemetryTime,
    };
  }

  /**
   * Emergency Pass Abort: Actuates physical carrier silencing switch on VGS SDR
   */
  async abortPass(dispatchId: string, reason: string, context: DispatchContext): Promise<PassAbortReceipt> {
    const existing = this.activeDispatches.get(dispatchId);

    // Timeout simulation
    if (this.simulateTimeout) {
      logger.warn({ dispatchId }, "[VgsAdapter] Simulating abort command timeout (ambiguous outcome)");
      throw new Error("ABORT_TRANSPORT_TIMEOUT");
    }

    // Actuate physical carrier silencing switch on VGS
    const silenceResult = this.vgs.emergencySilenceCarrier(reason);

    if (existing) {
      existing.abortedAt = silenceResult.silencedAt;
    }

    return {
      confirmedAt: silenceResult.silencedAt,
      rfCarrierSilenced: silenceResult.silenced,
      rawProviderResponse: {
        vgsStationCode: this.vgs.stationCode,
        rfPowerDbm: silenceResult.rfPowerDbm,
        hardwareInterlockStatus: "PHYSICAL_CARRIER_SILENCED",
      },
    };
  }

  /**
   * Validate RF requirements against VGS SDR capabilities
   */
  async validateCapabilities(stationId: string, requirements: RfRequirements): Promise<CapabilityValidationResult> {
    const isBandSupported = this.supportedBands.includes(requirements.frequencyBand);
    const isDataRateFeasible = requirements.dataRateMbps <= this.maxDataRateMbps;

    const unsupportedBands: string[] = [];
    if (!isBandSupported) {
      unsupportedBands.push(requirements.frequencyBand);
    }

    return {
      isCompatible: isBandSupported && isDataRateFeasible,
      unsupportedBands,
      maxDataRateFeasible: isDataRateFeasible,
      reason: !isBandSupported
        ? `Frequency band ${requirements.frequencyBand} not supported by VGS hardware`
        : !isDataRateFeasible
        ? `Requested ${requirements.dataRateMbps} Mbps exceeds VGS maximum ${this.maxDataRateMbps} Mbps`
        : undefined,
    };
  }
}
