import React from 'react';
import { Entity, PointGraphics } from 'resium';
import { Cartesian3, Color } from 'cesium';
import { SatellitePosition } from './map-types';

interface SatelliteLayerProps {
  satellites: SatellitePosition[];
  selectedSatelliteId?: string;
  onSelect?: (sat: SatellitePosition) => void;
  onDoubleClick?: (sat: SatellitePosition) => void;
}

export const SatelliteLayer: React.FC<SatelliteLayerProps> = ({
  satellites,
  selectedSatelliteId,
  onSelect,
  onDoubleClick
}) => {
  return (
    <>
      {satellites.map((sat) => {
        const isSelected = sat.satelliteId === selectedSatelliteId;
        const isGeo = sat.altitudeKm > 30000;
        
        let color = isGeo ? Color.fromCssColorString('#818cf8') : Color.fromCssColorString('#63eb80');
        if (isSelected) {
          color = Color.fromCssColorString('#38bdf8'); // High-visibility glowing cyan when selected
        }

        return (
          <Entity
            key={sat.satelliteId}
            name={sat.name}
            position={Cartesian3.fromDegrees(sat.longitude, sat.latitude, sat.altitudeKm * 1000)}
            description={`NORAD ID: ${sat.noradId}<br>Altitude: ${sat.altitudeKm} km<br>Source: ${sat.source}`}
            onClick={() => onSelect?.(sat)}
            onDoubleClick={() => onDoubleClick?.(sat)}
          >
            <PointGraphics
              pixelSize={isSelected ? 16 : (isGeo ? 10 : 8)}
              color={color}
              outlineColor={Color.WHITE}
              outlineWidth={isSelected ? 3.5 : 1.5}
            />
          </Entity>
        );
      })}
    </>
  );
};
