export interface VisibilitySample {
  timestamp: string; // ISO string
  elevationDeg: number;
  azimuthDeg: number;
  rangeKm: number;
  visible: boolean;
}
