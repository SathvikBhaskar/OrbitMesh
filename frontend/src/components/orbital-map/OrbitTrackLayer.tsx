import React, { useMemo } from 'react';
import { Entity, PolylineGraphics } from 'resium';
import { Cartesian3, Color } from 'cesium';
import { twoline2satrec, propagate, eciToGeodetic, gstime, degreesLat, degreesLong } from 'satellite.js';
import { SatellitePosition } from './map-types';

interface OrbitTrackLayerProps {
  satellites: SatellitePosition[];
  selectedSatelliteId?: string; // Optional: highlight selected
}

export const OrbitTrackLayer: React.FC<OrbitTrackLayerProps> = ({ satellites, selectedSatelliteId }) => {
  const tracks = useMemo(() => {
    const computedTracks: { satelliteId: string; positions: Cartesian3[]; isGeo: boolean }[] = [];
    const now = new Date();

    for (const sat of satellites) {
      if (!sat.tleLine1 || !sat.tleLine2) continue;

      try {
        const satrec = twoline2satrec(sat.tleLine1, sat.tleLine2);
        const positions = [];
        
        // Propagate for 90 minutes (1 point every 2 minutes)
        for (let i = 0; i <= 90; i += 2) {
          const time = new Date(now.getTime() + i * 60000);
          const pv = propagate(satrec, time);
          
          if (!pv || !pv.position || typeof pv.position === "boolean") continue;

          const posEci = pv.position as { x: number; y: number; z: number };
          const geo = eciToGeodetic(posEci, gstime(time));

          const latDeg = degreesLat(geo.latitude);
          const lonDeg = degreesLong(geo.longitude);
          const altM = geo.height * 1000;

          if (Number.isFinite(latDeg) && Number.isFinite(lonDeg) && Number.isFinite(altM)) {
            positions.push(lonDeg, latDeg, altM);
          }
        }

        if (positions.length > 0) {
          computedTracks.push({
            satelliteId: sat.satelliteId,
            positions: Cartesian3.fromDegreesArrayHeights(positions),
            isGeo: sat.altitudeKm > 30000
          });
        }
      } catch (e) {
        // Skip failed propagations
      }
    }
    return computedTracks;
  }, [satellites]);

  return (
    <>
      {tracks.map((track) => {
        const isSelected = track.satelliteId === selectedSatelliteId;
        const color = track.isGeo ? Color.fromCssColorString('#818cf8') : Color.fromCssColorString('#63eb80');
        
        return (
          <Entity key={`track-${track.satelliteId}`}>
            <PolylineGraphics
              positions={track.positions}
              width={isSelected ? 2 : 1}
              material={isSelected ? color : color.withAlpha(0.3)}
            />
          </Entity>
        );
      })}
    </>
  );
};
