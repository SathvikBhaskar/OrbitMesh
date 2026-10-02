import { Task, ContactWindow, Reservation, WorkloadFeatures, PolicyReason } from "../meta-scheduler/types";

// ==========================================
// 1. TLE Corpus Types
// ==========================================
export interface GPRecord {
  EPOCH: string;
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  INCLINATION: number;
  RA_OF_ASC_NODE: number;
  ARG_OF_PERICENTER: number;
  MEAN_ANOMALY: number;
  NORAD_CAT_ID: number;
  OBJECT_NAME?: string;
  CLASSIFICATION_TYPE?: string;
  EPHEMERIS_TYPE?: number;
  ELEMENT_SET_NO?: number;
  REV_AT_EPOCH?: number;
  BSTAR?: number;
  MEAN_MOTION_DOT?: number;
  MEAN_MOTION_DDOT?: number;
}

export type OrbitalClass = "LEO_CIRCULAR" | "LEO_SSO" | "GEO" | "MEO" | "UNKNOWN";

export interface CorpusPair {
  pairId: string;
  satelliteId: string;
  noradId: number;
  orbitalClass: OrbitalClass;
  t0: {
    epochMs: number;
    raw: GPRecord;
  };
  t1: {
    epochMs: number;
    raw: GPRecord;
  };
  epochGapHours: number;
  sourceRequestId: string;
  collectionTimestampMs: number;
  manoeuvreSuspected: boolean;
  hash: string;
}

// ==========================================
// 2. Stage B Characterization (Orbital & Windows)
// ==========================================
export interface LabContactWindow extends ContactWindow {
  satelliteId: string;
}

export type WindowClassification = "UNCHANGED" | "CHANGED" | "APPEARED" | "DISAPPEARED";

export interface MatchedWindow {
  w0: LabContactWindow | null;
  w1: LabContactWindow | null;
  overlapFraction: number;
  classification: WindowClassification;
  isSplit: boolean;
  isMerge: boolean;
}

export interface WindowMatchResult {
  matches: MatchedWindow[];
  cwf: number;
  wdr: number;
  war: number;
  meanAosShiftMs: number;
  meanLosShiftMs: number;
  meanRelativeDurationDelta: number;
  totalW0: number;
  totalW1: number;
}

export interface OrbitalDivergence {
  meanPositionDivergenceKm: number;
  maxPositionDivergenceKm: number;
  meanVelocityDivergenceMs: number;
}

// ==========================================
// 3. Stage C Impact Analysis
// ==========================================
export interface LabReservation extends Reservation {
  satelliteId: string;
}

export interface ImpactResult {
  sre: number;
  ir: number;
  spr: number;
  atf: number;
  sc: number;
  slf: number;
  invalidatedReservationIds: string[];
  affectedTaskIds: string[];
  slideableReservationIds: string[];
}

// ==========================================
// 4. Immutable Trial Snapshot
// ==========================================
export type LoadRegion = "BELOW" | "NEAR_LOW" | "AT" | "NEAR_HIGH" | "ABOVE";

export interface WorkloadMetadata {
  workloadSeed: string;
  region: LoadRegion;
  taskCount: number;
  features: WorkloadFeatures;
}

export interface TrialSnapshot {
  trialId: string;
  corpusPairId: string;
  workload: Task[];
  workloadMetadata: WorkloadMetadata;
  baselineSchedule: LabReservation[];
  w0: LabContactWindow[];
  w1_frozen: LabContactWindow[];
}

export interface TrialResult {
  trialId: string;
  corpusPairId: string;
  loadRegion: LoadRegion;
  taskCount: number;
  
  // Timing
  sr_compute: number;
  sr_e2e: number;
  t_regen_all: number;
  t_regen_partial: number;
  t_match: number;
  t_impact: number;
  t_sched_full: number;
  t_sched_targeted: number;
  
  // Quality
  full_pws: number;
  full_tp: number;
  full_dmr: number;

  targeted_pws: number;
  targeted_tp: number;
  targeted_dmr: number;

  oracle_pws: number;
  
  // Policy H4
  policyChanged: boolean;
  baselinePolicy: PolicyReason;
  reevaluatedPolicy: PolicyReason;
  policyBlindRegretPws: number;

  sre: number;
  ir: number;
  atf: number;
}
