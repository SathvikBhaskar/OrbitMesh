import React from 'react';
import { Entity, PolylineGraphics } from 'resium';
import { Cartesian3, Color } from 'cesium';
import { ContactWindow, SatellitePosition, GroundStation } from './map-types';

interface ContactWindowLayerProps {
  windows: ContactWindow[];
  satellites: SatellitePosition[];
  stations: GroundStation[];
  selectedSatelliteId?: string;
}

export const ContactWindowLayer: React.FC<ContactWindowLayerProps> = ({ windows, satellites, stations, selectedSatelliteId }) => {
  const now = Date.now();
  
  // Active windows occurring right now (strictly in-pass)
  const activeWindows = windows.filter((w) => {
    const aos = new Date(w.aos).getTime();
    const los = new Date(w.los).getTime();
    return now >= aos && now <= los;
  });

  // Upcoming windows within 30 minutes
  const upcomingWindows = windows.filter((w) => {
    const aos = new Date(w.aos).getTime();
    return aos > now && aos <= now + 30 * 60 * 1000;
  });

  // If a satellite is focused/selected, prioritize its beams; otherwise show active passes + top 3 upcoming
  const relevantWindows = selectedSatelliteId
    ? windows.filter(w => w.satelliteId === selectedSatelliteId && new Date(w.los).getTime() >= now && new Date(w.aos).getTime() <= now + 60 * 60 * 1000)
    : [...activeWindows, ...upcomingWindows.slice(0, 3)];

  const displayWindows = relevantWindows.slice(0, 5);

  return (
    <>
      {displayWindows.map((w) => {
        const sat = satellites.find((s) => s.satelliteId === w.satelliteId);
        const gs = stations.find((s) => s.id === w.groundStationId);

        if (!sat || !gs) return null;

        const isActive = now >= new Date(w.aos).getTime() && now <= new Date(w.los).getTime();

        const positions = Cartesian3.fromDegreesArrayHeights([
          gs.longitude, gs.latitude, gs.altitudeM,
          sat.longitude, sat.latitude, sat.altitudeKm * 1000
        ]);

        const beamColor = isActive 
          ? Color.fromCssColorString('#facc15').withAlpha(0.85) // Bright gold for active pass
          : Color.fromCssColorString('#38bdf8').withAlpha(0.35); // Cyan for upcoming pass

        return (
          <Entity key={w.id}>
            <PolylineGraphics
              positions={positions}
              width={isActive ? 3 : 1.5}
              material={beamColor}
            />
          </Entity>
        );
      })}
    </>
  );
};
