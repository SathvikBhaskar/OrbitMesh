/**
 * Phase 5.8: Workstream 5.8.2-A — AWS Ground Station Provider Types
 *
 * Models AWS Ground Station API contracts, contact lifecycle states,
 * and ARN structures while keeping AWS-specific models quarantined
 * within the adapter perimeter.
 */

export type AwsContactStatus =
  | "SCHEDULING"
  | "SCHEDULED"
  | "FAILED_TO_SCHEDULE"
  | "PREPASS"
  | "PASS"
  | "POSTPASS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLING"
  | "CANCELLED";

export interface AwsReserveContactRequest {
  groundStation: string;
  satelliteArn: string;
  missionProfileArn: string;
  startTime: string; // ISO 8601 UTC
  endTime: string;   // ISO 8601 UTC
  clientToken: string; // Idempotency token (1-64 chars)
  tags?: Record<string, string>;
}

export interface AwsContactResponse {
  contactId: string;
  contactStatus: AwsContactStatus;
  groundStation: string;
  satelliteArn: string;
  missionProfileArn: string;
  startTime: string;
  endTime: string;
  prePassStartTime?: string;
  postPassEndTime?: string;
  clientToken: string;
  tags?: Record<string, string>;
  dataBytes?: number;
  errorMessage?: string;
  creationTime: string;
}

export interface AwsGroundStationInfo {
  groundStationId: string;
  groundStationName: string;
  region: string;
  supportedBands: ("S_BAND" | "X_BAND" | "UHF" | "VHF" | "KA_BAND")[];
  maxDataRateMbps: number;
}

export interface IAwsGroundStationClient {
  reserveContact(request: AwsReserveContactRequest): Promise<AwsContactResponse>;
  describeContact(contactId: string): Promise<AwsContactResponse | null>;
  cancelContact(contactId: string): Promise<AwsContactResponse>;
  listGroundStations(): Promise<AwsGroundStationInfo[]>;
}

export interface AwsGroundStationAdapterOptions {
  region?: string;
  awsAccountId?: string;
  defaultMissionProfileArn?: string;
  stationCodeMap?: Record<string, string>;
  client?: IAwsGroundStationClient;
  // Conformance & Fault-Injection Simulation Flags
  simulateAbortTimeout?: boolean;
  simulateStageTimeout?: boolean;
  simulateStageRejection?: boolean;
  stageRejectionReason?: string;
  supportedBands?: ("S_BAND" | "X_BAND" | "UHF" | "VHF" | "KA_BAND")[];
  maxDataRateMbps?: number;
}
