import React from 'react';
import { Entity, PointGraphics, EllipseGraphics, PolylineGraphics, ModelGraphics } from 'resium';
import { Cartesian3, Color } from 'cesium';
import { SatellitePosition } from './map-types';

interface SatelliteLayerProps {
  satellites: SatellitePosition[];
  selectedSatelliteId?: string;
  isPivotMode?: boolean;
  onSelect?: (sat: SatellitePosition) => void;
  onDoubleClick?: (sat: SatellitePosition) => void;
}

export const SatelliteLayer: React.FC<SatelliteLayerProps> = ({
  satellites,
  selectedSatelliteId,
  isPivotMode = false,
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

        const swathRadiusMeters = isGeo ? 2_500_000 : Math.min(Math.max(sat.altitudeKm * 500, 200_000), 800_000);
        const satPos = Cartesian3.fromDegrees(sat.longitude, sat.latitude, sat.altitudeKm * 1000);
        const groundPos = Cartesian3.fromDegrees(sat.longitude, sat.latitude, 0);

        return (
          <React.Fragment key={sat.satelliteId}>
            <Entity
              name={sat.name}
              position={satPos}
              description={`NORAD ID: ${sat.noradId}<br>Altitude: ${sat.altitudeKm} km<br>Source: ${sat.source}`}
              onClick={() => onSelect?.(sat)}
              onDoubleClick={() => onDoubleClick?.(sat)}
            >
              {isSelected && isPivotMode ? (
                <ModelGraphics
                  uri="/models/satellite.gltf"
                  minimumPixelSize={110}
                  maximumScale={50000}
                  scale={3500}
                  runAnimations={true}
                />
              ) : (
                <PointGraphics
                  pixelSize={isSelected ? 16 : (isGeo ? 10 : 8)}
                  color={color}
                  outlineColor={Color.WHITE}
                  outlineWidth={isSelected ? 3.5 : 1.5}
                />
              )}
            </Entity>

            {/* Smart Focus: Nadir Ground Swath and Sub-Satellite Vector */}
            {isSelected && (
              <>
                <Entity
                  name={`${sat.name} Nadir Swath`}
                  position={groundPos}
                >
                  <EllipseGraphics
                    semiMajorAxis={swathRadiusMeters}
                    semiMinorAxis={swathRadiusMeters}
                    material={Color.fromCssColorString('rgba(56, 189, 248, 0.16)')}
                    outline={true}
                    outlineColor={Color.fromCssColorString('rgba(56, 189, 248, 0.75)')}
                    outlineWidth={1.5}
                  />
                </Entity>
                <Entity
                  name={`${sat.name} Nadir Line`}
                >
                  <PolylineGraphics
                    positions={[satPos, groundPos]}
                    width={1.5}
                    material={Color.fromCssColorString('rgba(56, 189, 248, 0.45)')}
                  />
                </Entity>
              </>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
};
