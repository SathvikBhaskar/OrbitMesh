import React from 'react';
import { Entity, PolylineGraphics } from 'resium';
import { Cartesian3, Color } from 'cesium';
import { ContactWindow, SatellitePosition, GroundStation } from './map-types';

interface ContactWindowLayerProps {
  windows: ContactWindow[];
  satellites: SatellitePosition[];
  stations: GroundStation[];
}

export const ContactWindowLayer: React.FC<ContactWindowLayerProps> = ({ windows, satellites, stations }) => {
  const activeWindows = windows.filter(w => w.status === 'ACTIVE');

  return (
    <>
      {activeWindows.map((w) => {
        const sat = satellites.find(s => s.satelliteId === w.satelliteId);
        const gs = stations.find(s => s.id === w.groundStationId);

        if (!sat || !gs) return null;

        const positions = Cartesian3.fromDegreesArrayHeights([
          gs.longitude, gs.latitude, gs.altitudeM,
          sat.longitude, sat.latitude, sat.altitudeKm * 1000
        ]);

        return (
          <Entity key={w.id}>
            <PolylineGraphics
              positions={positions}
              width={2}
              material={Color.fromCssColorString('#facc15').withAlpha(0.6)}
            />
          </Entity>
        );
      })}
    </>
  );
};
