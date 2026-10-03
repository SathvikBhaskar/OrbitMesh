import { twoline2satrec, propagate, eciToGeodetic, gstime, degreesLat, degreesLong, SatRec } from 'satellite.js';
import { SatellitePosition } from './map-types';

const satrecCache = new Map<string, SatRec>();

export function propagateSatellitesAtTime(
  satellites: SatellitePosition[],
  targetTime: Date
): SatellitePosition[] {
  const gmst = gstime(targetTime);

  return satellites.map((sat) => {
    if (!sat.tleLine1 || !sat.tleLine2) {
      return sat;
    }

    try {
      let satrec = satrecCache.get(sat.satelliteId);
      if (!satrec) {
        satrec = twoline2satrec(sat.tleLine1, sat.tleLine2);
        satrecCache.set(sat.satelliteId, satrec);
      }

      const pv = propagate(satrec, targetTime);
      if (!pv || !pv.position || typeof pv.position === 'boolean') {
        return sat;
      }

      const posEci = pv.position as { x: number; y: number; z: number };
      const geo = eciToGeodetic(posEci, gmst);

      const latDeg = degreesLat(geo.latitude);
      const lonDeg = degreesLong(geo.longitude);
      const altKm = geo.height;

      if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || !Number.isFinite(altKm)) {
        return sat;
      }

      return {
        ...sat,
        latitude: Math.round(latDeg * 1e4) / 1e4,
        longitude: Math.round(lonDeg * 1e4) / 1e4,
        altitudeKm: Math.round(altKm * 10) / 10,
        referenceTime: targetTime.toISOString(),
      };
    } catch {
      return sat;
    }
  });
}
