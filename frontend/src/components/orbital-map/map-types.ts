export interface SatellitePosition {
  satelliteId: string;
  noradId: number;
  name: string;
  status: string;
  latitude: number;
  longitude: number;
  altitudeKm: number;
  tleEpoch: string;
  source: string;
  referenceTime: string;
  tleLine1?: string;
  tleLine2?: string;
}

export interface GroundStation {
  id: string;
  code: string;
  name: string;
  latitude: number;
  longitude: number;
  altitudeM: number;
  minimumElevationDeg: number;
  status: string;
}

export interface ContactWindow {
  id: string;
  satelliteId: string;
  groundStationId: string;
  aos: string;
  los: string;
  status: string;
  satelliteName?: string;
  groundStationName?: string;
}

export interface MissionTask {
  id: string;
  satelliteId: string;
  type: string;
  status: string;
  windowStartTime: string;
  windowEndTime: string;
}
