/**
 * Phase 5.8: Workstream 5.8.2-B — CCSDS Space Link Extension (SLE) Types
 *
 * Applicable CCSDS Standards:
 * - CCSDS 911.1-B-5 (July 2023): Space Link Extension — Return All Frames (RAF) Service
 * - CCSDS 911.2-B-4 (July 2023): Space Link Extension — Return Channel Frames (RCF) Service
 * - CCSDS 913.1-B-2: SLE Internet Protocol for Transfer Services (ISP)
 * - CCSDS 132.0-B-3: TM Space Data Link Protocol (CADU framing)
 */

export type SleSessionState =
  | "UNBOUND"
  | "BINDING"
  | "BOUND"
  | "STARTING"
  | "ACTIVE"
  | "STOPPING"
  | "UNBINDING"
  | "BROKEN";

export type SleServiceType = "RAF" | "RCF" | "CLTU";

export type SleDeliveryMode = "onlineTimely" | "onlineComplete" | "offline";

export type SleBindDiagnostic =
  | "accessDenied"
  | "serviceTypeNotSupported"
  | "versionNotSupported"
  | "noSuchServiceInstance"
  | "alreadyBound"
  | "otherReason";

export type SleUnbindReason = "end" | "suspend" | "versionNotSupported" | "other";

export type SleStopReason = "normal" | "abnormal";

export type SleStartDiagnostic =
  | "outOfService"
  | "unableToComply"
  | "invalidStartTime"
  | "invalidStopTime"
  | "missingTimeValue"
  | "otherReason";

export interface SleCredentials {
  initiatorId: string;
  responderId: string;
  password?: string;
  hashAlgorithm?: "SHA256" | "MD5";
}

// ---------------------------------------------------------------------------
// SLE PDUs (Protocol Data Units) - CCSDS 911.1-B-5 & 911.2-B-4
// ---------------------------------------------------------------------------

export type SlePduType =
  | "BIND_REQUEST"
  | "BIND_RETURN"
  | "UNBIND_REQUEST"
  | "UNBIND_RETURN"
  | "START_REQUEST"
  | "START_RETURN"
  | "STOP_REQUEST"
  | "STOP_RETURN"
  | "TRANSFER_DATA"
  | "SCHEDULE_STATUS_REPORT"
  | "STATUS_REPORT"
  | "PEER_ABORT";

export interface BaseSlePdu {
  pduType: SlePduType;
  invokeId: number;
  timestamp: string; // ISO 8601 UTC
}

export interface SleBindRequestPdu extends BaseSlePdu {
  pduType: "BIND_REQUEST";
  initiatorIdentifier: string;
  serviceType: SleServiceType;
  versionNumber: number;
  serviceInstanceIdentifier: string;
}

export interface SleBindReturnPdu extends BaseSlePdu {
  pduType: "BIND_RETURN";
  result: "positive" | "negative";
  responderIdentifier: string;
  versionNumber: number;
  diagnostic?: SleBindDiagnostic;
}

export interface SleUnbindRequestPdu extends BaseSlePdu {
  pduType: "UNBIND_REQUEST";
  unbindReason: SleUnbindReason;
}

export interface SleUnbindReturnPdu extends BaseSlePdu {
  pduType: "UNBIND_RETURN";
  result: "positive";
}

export interface SleStartRequestPdu extends BaseSlePdu {
  pduType: "START_REQUEST";
  serviceType: SleServiceType;
  deliveryMode: SleDeliveryMode;
  startTime: string;
  stopTime: string;
}

export interface SleStartReturnPdu extends BaseSlePdu {
  pduType: "START_RETURN";
  result: "positive" | "negative";
  diagnostic?: SleStartDiagnostic;
}

export interface SleStopRequestPdu extends BaseSlePdu {
  pduType: "STOP_REQUEST";
  stopReason: SleStopReason;
}

export interface SleStopReturnPdu extends BaseSlePdu {
  pduType: "STOP_RETURN";
  result: "positive";
}

export interface SlePeerAbortPdu {
  pduType: "PEER_ABORT";
  diagnostic: "protocolError" | "unexpectedPdu" | "communicationsFailure" | "otherReason";
  timestamp: string;
}

/**
 * Return All Frames (RAF) Transfer Data Pdu
 * Delivers space-link CADUs (Channel Access Data Units)
 */
export interface RafTransferDataPdu extends BaseSlePdu {
  pduType: "TRANSFER_DATA";
  earthReceiveTime: string; // CCSDS CDS or ISO timestamp
  antennaId: string;
  dataLinkContinuity: number; // 0 = continuous, >0 = missing frames
  carrierLockStatus: boolean; // RF signal lock indicator from demodulator
  subcarrierLockStatus: boolean;
  symbolSyncLockStatus: boolean;
  frameSequenceNumber: number;
  frameData: Buffer; // CADU frame including Sync Marker (0x1ACFFC1D) + TM frame + RS parity
}

export interface SleStatusReportPdu extends BaseSlePdu {
  pduType: "STATUS_REPORT";
  carrierLock: boolean;
  subcarrierLock: boolean;
  symbolSyncLock: boolean;
  frameSyncLock: boolean;
  framesReceived: number;
  framesDelivered: number;
  framesDiscarded: number;
}

export type SlePdu =
  | SleBindRequestPdu
  | SleBindReturnPdu
  | SleUnbindRequestPdu
  | SleUnbindReturnPdu
  | SleStartRequestPdu
  | SleStartReturnPdu
  | SleStopRequestPdu
  | SleStopReturnPdu
  | RafTransferDataPdu
  | SleStatusReportPdu
  | SlePeerAbortPdu;

// ---------------------------------------------------------------------------
// Space Link Frame & Telemetry Extraction (CCSDS 132.0-B-3)
// ---------------------------------------------------------------------------

export interface CaduFrameHeader {
  syncMarker: number; // 0x1ACFFC1D (32 bits)
  version: number;    // 2 bits
  spacecraftId: number; // 10 bits (SCID)
  virtualChannelId: number; // 3 bits (VCID)
  operationalControlField: boolean; // 1 bit
  masterChannelFrameCount: number; // 8 bits
  virtualChannelFrameCount: number; // 8 bits
}

export interface ExtractedSpaceLinkFrame {
  header: CaduFrameHeader;
  earthReceiveTime: Date;
  sequenceNumber: number;
  rawFrameBytes: Buffer;
  payloadBytes: Buffer;
  isValidChecksum: boolean;
}

// ---------------------------------------------------------------------------
// Adapter Configuration & Options
// ---------------------------------------------------------------------------

export interface SleAdapterOptions {
  host?: string;
  port?: number;
  initiatorId?: string;
  responderId?: string;
  serviceInstanceId?: string;
  versionNumber?: number; // default: 5 (CCSDS 911.1-B-5)
  serviceType?: SleServiceType; // default: "RAF"
  supportedBands?: ("S_BAND" | "X_BAND" | "UHF" | "VHF" | "KA_BAND")[];
  maxDataRateMbps?: number;
  // Simulation & Fault-Injection Options
  simulateAbortTimeout?: boolean;
  simulateStageTimeout?: boolean;
  simulateStageRejection?: boolean;
  stageRejectionReason?: string;
  simulateTcpDropOnBind?: boolean;
  simulateTcpDropOnStart?: boolean;
  simulateSequenceGaps?: boolean;
}
