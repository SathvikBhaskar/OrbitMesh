import React from 'react';
import { Entity, PointGraphics } from 'resium';
import { Cartesian3, Color } from 'cesium';
import { SatellitePosition } from './map-types';

interface SatelliteLayerProps {
  satellites: SatellitePosition[];
  onSelect?: (sat: SatellitePosition) => void;
}

export const SatelliteLayer: React.FC<SatelliteLayerProps> = ({ satellites, onSelect }) => {
  return (
    <>
      {satellites.map((sat) => {
        const isGeo = sat.altitudeKm > 30000;
        const color = isGeo ? Color.fromCssColorString('#818cf8') : Color.fromCssColorString('#63eb80');
        
        return (
          <Entity
            key={sat.satelliteId}
            name={sat.name}
            position={Cartesian3.fromDegrees(sat.longitude, sat.latitude, sat.altitudeKm * 1000)}
            description={`NORAD ID: ${sat.noradId}<br>Altitude: ${sat.altitudeKm} km<br>Source: ${sat.source}`}
            onClick={() => onSelect?.(sat)}
          >
            <PointGraphics
              pixelSize={isGeo ? 10 : 8}
              color={color}
              outlineColor={Color.WHITE}
              outlineWidth={1.5}
            />
          </Entity>
        );
      })}
    </>
  );
};
