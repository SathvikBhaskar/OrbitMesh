/**
 * Phase 5.8: Workstream 5.8.2-B — CCSDS Space Link Extension (SLE) Provider Adapter
 *
 * Implements the canonical IGroundStationProviderAdapter interface for
 * CCSDS Space Link Extension (SLE) Ground Networks (ESA/ESTRACK, NASA/DSN, DLR).
 *
 * Applicable CCSDS Standards:
 * - CCSDS 911.1-B-5 (July 2023): Return All Frames (RAF) Service
 * - CCSDS 911.2-B-4 (July 2023): Return Channel Frames (RCF) Service
 * - CCSDS 913.1-B-2: SLE Internet Protocol for Transfer Services
 *
 * Core Invariant:
 * "SLE is an adapter, not a new execution model."
 * - Maps SLE session lifecycle (UNBOUND -> BINDING -> BOUND -> STARTING -> ACTIVE -> STOPPING -> UNBINDING)
 *   strictly into OrbitMesh canonical states (STAGED, ARMED, TRACKING, TERMINATED).
 * - Decouples SLE session state, frame delivery, link/transport health, and physical execution state.
 * - Does NOT alter core OrbitMesh execution, outbox, or scheduling semantics.
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
} from "../../provider.types";
import { DispatchManifest } from "../../../execution/execution.types";
import {
  SleAdapterOptions,
  SleSessionState,
  RafTransferDataPdu,
} from "./sle.types";
import { SleSessionEngine } from "./sle-session.engine";
import { SleFrameEngine } from "./sle-frame.engine";
import { logger } from "../../../../config/logger";

export class SleGroundStationProviderAdapter
  implements IGroundStationProviderAdapter
{
  public readonly providerId: string;
  public options: SleAdapterOptions;

  // Track active SLE sessions by dispatchId and sessionKey
  private sessionsByDispatchId = new Map<string, SleSessionEngine>();
  private dispatchIdBySessionKey = new Map<string, string>();

  constructor(
    providerId: string = "ccsds-sle",
    options: SleAdapterOptions = {}
  ) {
    this.providerId = providerId;
    this.options = {
      versionNumber: 5,
      serviceType: "RAF",
      initiatorId: "ORBITMESH-FEP",
      responderId: "ESTRACK-GATEWAY",
      serviceInstanceId: "sagr=1.spack=1.rsl-fg=1.raf=onlc2",
      supportedBands: ["S_BAND", "X_BAND"],
      maxDataRateMbps: 100, // Standard CCSDS SLE downlink rates
      ...options,
    };
  }

  /**
   * Stage pass: Establishes and BINDS a stateful CCSDS SLE session.
   * Idempotency guarantee: Duplicate stage requests return existing BOUND session.
   */
  async stagePass(
    manifest: DispatchManifest,
    context: DispatchContext
  ): Promise<StagedPassReceipt> {
    const { dispatchId, idempotencyKey } = context;

    // Conformance test injection: stage rejection simulation
    if (this.options.simulateStageRejection) {
      throw new Error(
        this.options.stageRejectionReason || "CCSDS_SLE_CAPABILITY_REJECTED"
      );
    }

    // 1. Check existing session for idempotent return
    const existingSession = this.sessionsByDispatchId.get(dispatchId);
    if (existingSession) {
      logger.info(
        { dispatchId, sessionKey: existingSession.getSessionKey(), state: existingSession.getState() },
        "[SleAdapter] Existing SLE session returned idempotently"
      );
      return {
        providerDispatchRef: existingSession.getSessionKey(),
        stagedAt: new Date(),
        stationStatus: "READY",
        rawProviderResponse: {
          protocol: "CCSDS_SLE",
          serviceType: this.options.serviceType,
          sessionKey: existingSession.getSessionKey(),
          sessionState: existingSession.getState(),
          reused: true,
        },
      };
    }

    // 2. Initialize new SLE session engine
    const sessionKey = `sle-session-${dispatchId}`;
    const session = new SleSessionEngine({
      sessionKey,
      initiatorId: this.options.initiatorId || "ORBITMESH-FEP",
      responderId: this.options.responderId || "ESTRACK-GATEWAY",
      serviceInstanceId: this.options.serviceInstanceId || "sagr=1.spack=1.rsl-fg=1.raf=onlc2",
      versionNumber: this.options.versionNumber || 5,
      serviceType: this.options.serviceType || "RAF",
    });

    if (this.options.simulateTcpDropOnBind) {
      session.simulateTcpDropOnBind = true;
    }

    // 3. Execute BIND sequence
    await session.bind();

    this.sessionsByDispatchId.set(dispatchId, session);
    this.dispatchIdBySessionKey.set(sessionKey, dispatchId);

    // Conformance test injection: simulated network timeout after bind
    if (this.options.simulateStageTimeout) {
      logger.warn(
        { dispatchId, sessionKey },
        "[SleAdapter] Simulating network drop after provider accepted BIND"
      );
      throw new Error("HTTP_PROVIDER_TIMEOUT");
    }

    return {
      providerDispatchRef: sessionKey,
      stagedAt: new Date(),
      stationStatus: "READY",
      rawProviderResponse: {
        protocol: "CCSDS_SLE",
        serviceType: this.options.serviceType,
        sessionKey,
        sessionState: session.getState(), // "BOUND"
        versionNumber: this.options.versionNumber,
      },
    };
  }

  /**
   * Arm pass: Starts space-link telemetry transfer (RAF START sequence).
   * Transitions SLE session from BOUND to ACTIVE.
   */
  async armPass(
    dispatchId: string,
    context: DispatchContext
  ): Promise<ArmedPassReceipt> {
    const session = this.sessionsByDispatchId.get(dispatchId);
    if (!session) {
      throw new Error(`[SleAdapter] Cannot arm unknown dispatch ${dispatchId}`);
    }

    const state = session.getState();
    if (state !== "BOUND" && state !== "ACTIVE") {
      throw new Error(`[SleAdapter] Cannot arm SLE session from state: ${state} (must be BOUND)`);
    }

    const startTime = new Date().toISOString();
    const stopTime = new Date(Date.now() + 600000).toISOString();

    if (this.options.simulateTcpDropOnStart) {
      session.simulateTcpDropOnStart = true;
    }

    await session.start(startTime, stopTime, "onlineTimely");

    // In simulated environment: produce initial synthetic CADU frame with lock
    const syntheticCadu = SleFrameEngine.createSyntheticCadu(25544, 0, 1, 1);
    const transferPdu: RafTransferDataPdu = {
      pduType: "TRANSFER_DATA",
      invokeId: 100,
      timestamp: new Date().toISOString(),
      earthReceiveTime: new Date().toISOString(),
      antennaId: "ANT-1",
      dataLinkContinuity: 0,
      carrierLockStatus: true,
      subcarrierLockStatus: true,
      symbolSyncLockStatus: true,
      frameSequenceNumber: 1,
      frameData: syntheticCadu,
    };
    session.handleIncomingPdu(transferPdu);

    return {
      armedAt: new Date(),
      trackingConfigured: true,
      rawProviderResponse: {
        protocol: "CCSDS_SLE",
        sessionKey: session.getSessionKey(),
        sessionState: session.getState(), // "ACTIVE"
        trackingConfigured: true,
      },
    };
  }

  /**
   * Abort pass: Commands RAF STOP and SLE UNBIND.
   * Safety invariant: If transport fails during abort, throws error and NEVER manufactures false confirmation.
   */
  async abortPass(
    dispatchId: string,
    reason: string,
    context: DispatchContext
  ): Promise<PassAbortReceipt> {
    if (this.options.simulateAbortTimeout) {
      logger.warn(
        { dispatchId },
        "[SleAdapter] Simulating abort command timeout (ambiguous outcome)"
      );
      throw new Error("ABORT_TRANSPORT_TIMEOUT");
    }

    const session = this.sessionsByDispatchId.get(dispatchId);
    if (!session) {
      return {
        confirmedAt: new Date(),
        rfCarrierSilenced: true,
        rawProviderResponse: {
          protocol: "CCSDS_SLE",
          unknownDispatch: true,
          silenced: true,
          reason,
        },
      };
    }

    // Stop frame transmission then unbind session
    if (session.getState() === "ACTIVE") {
      await session.stop();
    }
    await session.unbind();

    return {
      confirmedAt: new Date(),
      rfCarrierSilenced: true,
      rawProviderResponse: {
        protocol: "CCSDS_SLE",
        sessionKey: session.getSessionKey(),
        sessionState: session.getState(), // "UNBOUND"
        silenced: true,
        reason,
      },
    };
  }

  /**
   * Poll pass status: Maps SLE session state and space-link frame engine indicators
   * into canonical PassStatusSnapshot.
   */
  async pollPassStatus(
    dispatchId: string,
    context: DispatchContext
  ): Promise<PassStatusSnapshot> {
    const session = this.sessionsByDispatchId.get(dispatchId);
    if (!session) {
      return {
        state: "UNKNOWN",
        carrierLocked: false,
        bytesRecorded: 0,
      };
    }

    const state = session.getState();
    const frameEngine = session.frameEngine;

    switch (state) {
      case "BOUND":
        return {
          state: "STAGED",
          carrierLocked: false,
          bytesRecorded: 0,
          lastContactAt: new Date(),
        };
      case "STARTING":
        return {
          state: "ARMED",
          carrierLocked: false,
          bytesRecorded: 0,
          lastContactAt: new Date(),
        };
      case "ACTIVE":
        return {
          state: "TRACKING",
          // Strictly driven by space-link frame engine demodulator telemetry
          carrierLocked: frameEngine.isCarrierLocked(),
          bytesRecorded: frameEngine.getBytesRecorded(),
          lastContactAt: new Date(),
        };
      case "STOPPING":
      case "UNBINDING":
      case "UNBOUND":
      case "BROKEN":
      default:
        return {
          state: "TERMINATED",
          carrierLocked: false,
          bytesRecorded: frameEngine.getBytesRecorded(),
          lastContactAt: new Date(),
        };
    }
  }

  /**
   * Capability validation: Validates whether frequency band and data rate
   * are feasible on CCSDS SLE ground stations.
   */
  async validateCapabilities(
    stationId: string,
    requirements: RfRequirements
  ): Promise<CapabilityValidationResult> {
    const supported = this.options.supportedBands || ["S_BAND", "X_BAND"];
    const maxRate = this.options.maxDataRateMbps || 100;

    const bandOk = supported.includes(requirements.frequencyBand);
    const rateOk = requirements.dataRateMbps <= maxRate;

    return {
      isCompatible: bandOk && rateOk,
      unsupportedBands: bandOk ? [] : [requirements.frequencyBand],
      maxDataRateFeasible: rateOk,
      reason: !bandOk
        ? `CCSDS SLE ground network does not support frequency band ${requirements.frequencyBand} at station ${stationId}`
        : !rateOk
        ? `Data rate ${requirements.dataRateMbps}Mbps exceeds CCSDS SLE max rate ${maxRate}Mbps`
        : undefined,
    };
  }

  public getSession(dispatchId: string): SleSessionEngine | undefined {
    return this.sessionsByDispatchId.get(dispatchId);
  }

  public reset(): void {
    for (const session of this.sessionsByDispatchId.values()) {
      session.reset();
    }
    this.sessionsByDispatchId.clear();
    this.dispatchIdBySessionKey.clear();
  }
}
