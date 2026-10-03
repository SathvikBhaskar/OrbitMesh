import { SatellitePosition, GroundStation, ContactWindow } from './map-types';
import { twoline2satrec, propagate, eciToGeodetic, gstime, degreesLat, degreesLong } from 'satellite.js';

export interface TopocentricCoordinates {
  azimuth: number;
  elevation: number;
  slantRangeKm: number;
}

export interface SkyTarget {
  satellite: SatellitePosition;
  azimuth: number;
  elevation: number;
  slantRangeKm: number;
  isInBeam: boolean;
  isActivePass: boolean;
  compass: string;
}

export interface SkyTrackPoint {
  azimuthDeg: number;
  elevationDeg: number;
}

/**
 * Calculates topocentric Azimuth, Elevation, and Slant Range
 * from a ground station to a satellite in Earth-Centered, Earth-Fixed (ECEF) frame.
 */
export function calculateAzEl(
  stationLatDeg: number,
  stationLonDeg: number,
  stationAltM: number,
  satLatDeg: number,
  satLonDeg: number,
  satAltKm: number
): TopocentricCoordinates {
  const DEG2RAD = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;
  const RE = 6378.137; // WGS-84 equatorial radius in km

  const phi_s = stationLatDeg * DEG2RAD;
  const lam_s = stationLonDeg * DEG2RAD;
  const h_s = (stationAltM || 0) / 1000;

  const phi_t = satLatDeg * DEG2RAD;
  const lam_t = satLonDeg * DEG2RAD;
  const h_t = satAltKm;

  // Ground Station Position in ECEF
  const r_s = RE + h_s;
  const Xs = r_s * Math.cos(phi_s) * Math.cos(lam_s);
  const Ys = r_s * Math.cos(phi_s) * Math.sin(lam_s);
  const Zs = r_s * Math.sin(phi_s);

  // Satellite Position in ECEF
  const r_t = RE + h_t;
  const Xt = r_t * Math.cos(phi_t) * Math.cos(lam_t);
  const Yt = r_t * Math.cos(phi_t) * Math.sin(lam_t);
  const Zt = r_t * Math.sin(phi_t);

  // Range vector in ECEF
  const dx = Xt - Xs;
  const dy = Yt - Ys;
  const dz = Zt - Zs;

  // Convert to Topocentric Horizon Frame (East, North, Up)
  const east = -Math.sin(lam_s) * dx + Math.cos(lam_s) * dy;
  const north = -Math.sin(phi_s) * Math.cos(lam_s) * dx - Math.sin(phi_s) * Math.sin(lam_s) * dy + Math.cos(phi_s) * dz;
  const up = Math.cos(phi_s) * Math.cos(lam_s) * dx + Math.cos(phi_s) * Math.sin(lam_s) * dy + Math.sin(phi_s) * dz;

  const slantRange = Math.sqrt(east * east + north * north + up * up);
  const elevation = Math.asin(Math.max(-1, Math.min(1, up / slantRange))) * RAD2DEG;
  let azimuth = Math.atan2(east, north) * RAD2DEG;
  if (azimuth < 0) azimuth += 360;

  return {
    azimuth,
    elevation,
    slantRangeKm: slantRange
  };
}

export function getCompassHeading(azimuthDeg: number): string {
  const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const index = Math.round(azimuthDeg / 22.5) % 16;
  return directions[index];
}

/**
 * Evaluates all satellites relative to a ground station at current simulation time.
 * Returns the highest satellite, active pass, or nearest approaching satellite.
 */
export function getGroundStationSkyTracking(
  station: GroundStation,
  satellites: SatellitePosition[],
  windows: ContactWindow[] = [],
  currentTime: Date = new Date()
): {
  primaryTarget: SkyTarget | null;
  secondaryTargets: SkyTarget[];
  trackPoints: SkyTrackPoint[];
} {
  const nowMs = currentTime.getTime();
  const minElev = station.minimumElevationDeg || 10;

  // Check if there is an actively scheduled contact window for this station right now
  const activeWindow = windows.find(w => {
    if (w.groundStationId !== station.id) return false;
    const aos = new Date(w.aos).getTime();
    const los = new Date(w.los).getTime();
    return nowMs >= aos && nowMs <= los;
  });

  // Calculate real Az/El for all satellites
  const allTargets: SkyTarget[] = [];

  for (const sat of satellites) {
    const coords = calculateAzEl(
      station.latitude,
      station.longitude,
      station.altitudeM,
      sat.latitude,
      sat.longitude,
      sat.altitudeKm
    );

    const isInBeam = coords.elevation >= minElev;
    const isActivePass = Boolean(activeWindow && activeWindow.satelliteId === sat.satelliteId);

    allTargets.push({
      satellite: sat,
      azimuth: coords.azimuth,
      elevation: coords.elevation,
      slantRangeKm: coords.slantRangeKm,
      isInBeam,
      isActivePass,
      compass: getCompassHeading(coords.azimuth)
    });
  }

  // Sort: active pass first, then highest elevation
  allTargets.sort((a, b) => {
    if (a.isActivePass && !b.isActivePass) return -1;
    if (!a.isActivePass && b.isActivePass) return 1;
    return b.elevation - a.elevation;
  });

  const primaryTarget = allTargets.length > 0 ? allTargets[0] : null;
  // Satellites that are also above the horizon (elevation > 0)
  const secondaryTargets = allTargets.slice(1).filter(t => t.elevation > 0).slice(0, 5);

  // Generate pass arc trajectory for primary target if TLE is available
  const trackPoints: SkyTrackPoint[] = [];
  if (primaryTarget && primaryTarget.satellite.tleLine1 && primaryTarget.satellite.tleLine2) {
    try {
      const satrec = twoline2satrec(primaryTarget.satellite.tleLine1, primaryTarget.satellite.tleLine2);
      // Sample ±12 minutes around currentTime (every 1 minute)
      for (let offset = -12; offset <= 12; offset += 1) {
        const stepTime = new Date(nowMs + offset * 60000);
        const pv = propagate(satrec, stepTime);
        if (pv && pv.position && typeof pv.position !== 'boolean') {
          const gmst = gstime(stepTime);
          const geo = eciToGeodetic(pv.position as any, gmst);
          const lat = degreesLat(geo.latitude);
          const lon = degreesLong(geo.longitude);
          const altKm = geo.height;

          const ptCoords = calculateAzEl(
            station.latitude,
            station.longitude,
            station.altitudeM,
            lat,
            lon,
            altKm
          );

          if (ptCoords.elevation >= -5) {
            trackPoints.push({
              azimuthDeg: ptCoords.azimuth,
              elevationDeg: ptCoords.elevation
            });
          }
        }
      }
    } catch {
      // Ignore propagation errors
    }
  }

  return {
    primaryTarget,
    secondaryTargets,
    trackPoints
  };
}
