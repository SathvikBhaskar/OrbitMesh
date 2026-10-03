/**
 * Phase 5.8: Workstream 5.8.4 — Hardware-in-the-Loop (HIL) & Virtual Ground Station (VGS)
 * Virtual Ground Station (VGS) Hardware-in-the-Loop SDR Simulation Engine
 */

import crypto from "crypto";
import { ChannelEmulator, ChannelMetricsSnapshot, ChannelEmulatorOptions } from "./channel-emulator";
import { DigitalBasebandService, CaduFrame, BasebandMetrics } from "./digital-baseband.service";
import { groundSecurityService, GroundSecurityService } from "../crypto.service";
import { SignedPayloadHeader } from "../provider.types";
import { logger } from "../../../config/logger";

export interface VgsPassConfig {
  readonly dispatchId: string;
  readonly satelliteId: string;
  readonly stationCode: string;
  readonly aosTime: Date;
  readonly losTime: Date;
  readonly scid: number;
  readonly vcid: number;
  readonly keyId?: string;
  readonly secretKey?: string;
}

export interface VgsPassStatus {
  readonly state: "STAGED" | "ARMED" | "TRACKING" | "TERMINATED";
  readonly carrierLocked: boolean;
  readonly rfPowerDbm: number;
  readonly snrDb: number;
  readonly dopplerShiftHz: number;
  readonly elevationDeg: number;
  readonly azimuthDeg: number;
  readonly bytesRecorded: number;
  readonly validFramesCount: number;
  readonly droppedFramesCount: number;
  readonly carrierSilenced: boolean;
  readonly lastTelemetryTime: Date;
}

export interface SignedVgsTelemetry {
  readonly headers: SignedPayloadHeader;
  readonly dispatchId: string;
  readonly sequenceNumber: number;
  readonly payload: {
    readonly carrierLocked: boolean;
    readonly snrDb: number;
    readonly dopplerShiftHz: number;
    readonly elevationDeg: number;
    readonly bytesRecorded: number;
    readonly rfPowerDbm: number;
    readonly timestamp: string;
  };
}

export class VirtualGroundStation {
  public readonly stationCode: string;
  private readonly channel: ChannelEmulator;
  private readonly baseband: DigitalBasebandService;
  private readonly cryptoService: GroundSecurityService;

  private state: "STANDBY" | "STAGED" | "ARMED" | "TRACKING" | "TERMINATED" = "STANDBY";
  private activePass?: VgsPassConfig;
  private carrierSilenced = false;
  private telemetrySequence = 0;
  private defaultKeyId = "key-vgs-default";
  private defaultSecretKey = "vgs-default-secret-key-32bytes!";

  public configureCredentials(keyId: string, secretKey: string): void {
    this.defaultKeyId = keyId;
    this.defaultSecretKey = secretKey;
  }

  constructor(
    stationCode = "VGS-SDR-01",
    channelOptions: ChannelEmulatorOptions = {},
    baseband = new DigitalBasebandService(),
    cryptoService = groundSecurityService
  ) {
    this.stationCode = stationCode;
    this.channel = new ChannelEmulator(channelOptions);
    this.baseband = baseband;
    this.cryptoService = cryptoService;
  }

  /**
   * Stage a pass in the VGS equipment rack
   */
  public stagePass(config: VgsPassConfig): void {
    this.activePass = config;
    this.state = "STAGED";
    this.carrierSilenced = false;
    this.telemetrySequence = 0;
    this.channel.setTransmitterState(true);
    this.baseband.reset();

    logger.info(
      { stationCode: this.stationCode, dispatchId: config.dispatchId },
      "[VGS] Pass staged in SDR hardware rack"
    );
  }

  /**
   * Arm tracking antenna and engage SDR Doppler tracking loop
   */
  public armPass(dispatchId: string): void {
    if (!this.activePass || this.activePass.dispatchId !== dispatchId) {
      throw new Error(`Cannot arm: pass [${dispatchId}] not staged in VGS`);
    }
    this.state = "ARMED";
    logger.info({ stationCode: this.stationCode, dispatchId }, "[VGS] SDR Doppler receiver armed");
  }

  /**
   * Step physical contact simulation to normalized pass progress [-1.0, +1.0]
   * -1.0 = AOS, 0.0 = Zenith / CPA, +1.0 = LOS
   */
  public stepSimulation(
    normalizedProgress: number,
    currentTime = new Date()
  ): {
    metrics: ChannelMetricsSnapshot;
    frames: CaduFrame[];
    basebandMetrics: BasebandMetrics;
  } {
    if (this.state === "ARMED" || this.state === "STAGED") {
      this.state = "TRACKING";
    }

    // 1. Evaluate physical RF propagation via ChannelEmulator
    const metrics = this.channel.evaluateChannelAtProgress(normalizedProgress, currentTime);

    // 2. Synthesize CADU stream if transmitter is active and in view
    let streamBuffer = Buffer.alloc(0);
    if (!this.carrierSilenced && metrics.carrierLocked) {
      // Generate CADU frames for this simulation step (e.g. 5 frames ~ 5KB)
      const framesToGenerate = 5;
      const chunks: Buffer[] = [];
      for (let i = 0; i < framesToGenerate; i++) {
        chunks.push(
          this.baseband.generateCaduFrame(
            this.telemetrySequence * framesToGenerate + i,
            this.activePass?.scid ?? 101,
            this.activePass?.vcid ?? 1
          )
        );
      }
      streamBuffer = Buffer.concat(chunks);
    }

    // 3. Process baseband through sync and noise engine
    const { frames, metrics: basebandMetrics } = this.baseband.processBasebandStream(
      streamBuffer,
      metrics.carrierLocked && !this.carrierSilenced,
      metrics.snrDb
    );

    return { metrics, frames, basebandMetrics };
  }

  /**
   * Emergency Physical Carrier Silencing Interlock (§5.1, §5.3, §5.8.4)
   * Actuates solid-state RF switch directly, clamping output power to noise floor (<50ms).
   */
  public emergencySilenceCarrier(reason: string): {
    silenced: boolean;
    silencedAt: Date;
    rfPowerDbm: number;
  } {
    const silencedAt = new Date();
    this.carrierSilenced = true;
    this.channel.setTransmitterState(false, -110.0);
    this.state = "TERMINATED";

    logger.warn(
      { stationCode: this.stationCode, reason, silencedAt: silencedAt.toISOString() },
      "[VGS_INTERLOCK] Physical carrier silenced via hardware RF switch: RF output clamped to -110 dBm"
    );

    return {
      silenced: true,
      silencedAt,
      rfPowerDbm: -110.0,
    };
  }

  /**
   * Get instantaneous physical pass snapshot
   */
  public getSnapshot(normalizedProgress = 0.0, currentTime = new Date()): VgsPassStatus {
    const channelMetrics = this.channel.evaluateChannelAtProgress(normalizedProgress, currentTime);
    const basebandMetrics = this.baseband.getMetrics(channelMetrics.snrDb);

    const isLocked = !this.carrierSilenced && channelMetrics.carrierLocked;
    const rfPowerDbm = this.carrierSilenced ? -110.0 : channelMetrics.transmitterPowerDbm;

    let passState: VgsPassStatus["state"] = "TRACKING";
    if (this.state === "TERMINATED" || this.carrierSilenced) {
      passState = "TERMINATED";
    } else if (this.state === "STAGED") {
      passState = "STAGED";
    } else if (this.state === "ARMED") {
      passState = "ARMED";
    }

    return {
      state: passState,
      carrierLocked: isLocked,
      rfPowerDbm: Number(rfPowerDbm.toFixed(2)),
      snrDb: this.carrierSilenced ? 0 : channelMetrics.snrDb,
      dopplerShiftHz: this.carrierSilenced ? 0 : channelMetrics.dopplerShiftHz,
      elevationDeg: channelMetrics.elevationDeg,
      azimuthDeg: channelMetrics.azimuthDeg,
      bytesRecorded: basebandMetrics.byteTransferCount,
      validFramesCount: basebandMetrics.validFrames,
      droppedFramesCount: basebandMetrics.droppedFrames,
      carrierSilenced: this.carrierSilenced,
      lastTelemetryTime: currentTime,
    };
  }

  /**
   * Generate cryptographically signed physical telemetry packet for OrbitMesh outbox/ingestion
   */
  public generateSignedTelemetry(
    normalizedProgress = 0.0,
    currentTime = new Date()
  ): SignedVgsTelemetry {
    this.telemetrySequence++;
    const snapshot = this.getSnapshot(normalizedProgress, currentTime);
    const timestampIso = currentTime.toISOString();
    const nonce = `vgs-nonce-${crypto.randomUUID().slice(0, 8)}`;
    const dispatchId = this.activePass?.dispatchId ?? "disp-vgs-default";
    const keyId = this.activePass?.keyId ?? this.defaultKeyId;
    const secretKey = this.activePass?.secretKey ?? this.defaultSecretKey;

    const payload = {
      carrierLocked: snapshot.carrierLocked,
      snrDb: snapshot.snrDb,
      dopplerShiftHz: snapshot.dopplerShiftHz,
      elevationDeg: snapshot.elevationDeg,
      bytesRecorded: snapshot.bytesRecorded,
      rfPowerDbm: snapshot.rfPowerDbm,
      timestamp: timestampIso,
    };

    const canonical = this.cryptoService.buildCanonicalString(
      dispatchId,
      this.telemetrySequence,
      timestampIso,
      nonce,
      payload
    );

    const signature = this.cryptoService.generateSignature(secretKey, canonical);

    return {
      headers: {
        keyId,
        signature,
        nonce,
        timestamp: timestampIso,
      },
      dispatchId,
      sequenceNumber: this.telemetrySequence,
      payload,
    };
  }
}
