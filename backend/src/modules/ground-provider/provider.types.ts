/**
 * Phase 5.7: Workstream 5.7.2 & 5.7.3 — Provider Adapter & Security Provenance Types
 */

import { DispatchManifest } from "../execution/execution.types";

export interface DispatchContext {
  readonly dispatchId: string;
  readonly attemptNumber: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly providerId: string;
  readonly stationCode: string;
}

export interface RfRequirements {
  readonly frequencyBand: "S_BAND" | "X_BAND" | "UHF" | "VHF" | "KA_BAND";
  readonly dataRateMbps: number;
  readonly polarization?: "RHCP" | "LHCP" | "LINEAR";
}

export interface CapabilityValidationResult {
  readonly isCompatible: boolean;
  readonly unsupportedBands: string[];
  readonly maxDataRateFeasible: boolean;
  readonly reason?: string | undefined;
}

export interface StagedPassReceipt {
  readonly providerDispatchRef: string;
  readonly stagedAt: Date;
  readonly stationStatus: "READY" | "STANDBY" | "BUSY";
  readonly rawProviderResponse: Record<string, unknown>;
}

export interface ArmedPassReceipt {
  readonly armedAt: Date;
  readonly trackingConfigured: boolean;
  readonly rawProviderResponse: Record<string, unknown>;
}

export interface PassAbortReceipt {
  readonly confirmedAt: Date;
  readonly rfCarrierSilenced: boolean;
  readonly rawProviderResponse: Record<string, unknown>;
}

export interface PassStatusSnapshot {
  readonly state: "STAGED" | "ARMED" | "TRACKING" | "TERMINATED" | "UNKNOWN";
  readonly carrierLocked: boolean;
  readonly bytesRecorded: number;
  readonly snrDb?: number;
  readonly lastContactAt?: Date;
}

export interface IGroundStationProviderAdapter {
  readonly providerId: string;

  stagePass(manifest: DispatchManifest, context: DispatchContext): Promise<StagedPassReceipt>;
  armPass(dispatchId: string, context: DispatchContext): Promise<ArmedPassReceipt>;
  abortPass(dispatchId: string, reason: string, context: DispatchContext): Promise<PassAbortReceipt>;
  pollPassStatus?(dispatchId: string, context: DispatchContext): Promise<PassStatusSnapshot>;
  validateCapabilities(stationId: string, requirements: RfRequirements): Promise<CapabilityValidationResult>;
}

export interface SignedPayloadHeader {
  readonly keyId: string;
  readonly signature: string;
  readonly nonce: string;
  readonly timestamp: string; // ISO UTC string
}

export interface SignatureVerificationResult {
  readonly isValid: boolean;
  readonly stationId?: string;
  readonly keyId?: string;
  readonly errorCode?:
    | "MISSING_HEADERS"
    | "INVALID_SIGNATURE"
    | "CREDENTIAL_NOT_FOUND"
    | "CREDENTIAL_REVOKED"
    | "CREDENTIAL_EXPIRED"
    | "CLOCK_SKEW_EXCEEDED"
    | "NONCE_REPLAY_DETECTED"
    | "ROTATION_GRACE_EXCEEDED";
  readonly errorMessage?: string;
}
