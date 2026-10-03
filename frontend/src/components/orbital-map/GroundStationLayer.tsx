import React from 'react';
import { Entity, PointGraphics, LabelGraphics, EllipseGraphics } from 'resium';
import { Cartesian3, Color, Cartesian2, HorizontalOrigin, VerticalOrigin } from 'cesium';
import { GroundStation } from './map-types';

interface GroundStationLayerProps {
  stations: GroundStation[];
  selectedStationId?: string;
  showAllFootprints?: boolean;
  onSelect?: (station: GroundStation) => void;
  onDoubleClick?: (station: GroundStation) => void;
}

/**
 * Calculates ground station coverage radius at Earth surface
 * for a satellite at nominal 700 km LEO altitude given the station's minimum elevation mask.
 */
function getStationCoverageRadius(minElevationDeg: number = 10, altKm: number = 700): number {
  const RE = 6371; // Earth radius in km
  const h = altKm;
  const thetaRad = ((minElevationDeg || 10) * Math.PI) / 180;
  const sinPsi = (RE * Math.cos(thetaRad)) / (RE + h);
  const gamma = Math.PI / 2 - thetaRad - Math.asin(Math.min(sinPsi, 1.0));
  return Math.max(gamma * RE * 1000, 300_000); // meters
}

export const GroundStationLayer: React.FC<GroundStationLayerProps> = ({
  stations,
  selectedStationId,
  showAllFootprints = false,
  onSelect,
  onDoubleClick
}) => {
  return (
    <>
      {stations.map((gs) => {
        const isSelected = gs.id === selectedStationId;
        const showFootprint = isSelected || showAllFootprints;
        const radiusMeters = getStationCoverageRadius(gs.minimumElevationDeg || 10, 700);

        return (
          <React.Fragment key={gs.id}>
            <Entity
              name={gs.name}
              position={Cartesian3.fromDegrees(gs.longitude, gs.latitude, gs.altitudeM)}
              description={`Code: ${gs.code}<br>Elevation: ${gs.altitudeM} m<br>Min Elev: ${gs.minimumElevationDeg}°`}
              onClick={() => onSelect?.(gs)}
              onDoubleClick={() => onDoubleClick?.(gs)}
            >
              <PointGraphics
                pixelSize={isSelected ? 18 : 12}
                color={isSelected ? Color.fromCssColorString('#facc15') : Color.fromCssColorString('#f59e0b')}
                outlineColor={Color.WHITE}
                outlineWidth={isSelected ? 3.5 : 2}
              />
              <LabelGraphics
                text={gs.code}
                font={isSelected ? "bold 12px sans-serif" : "10px sans-serif"}
                fillColor={Color.WHITE}
                showBackground={true}
                backgroundColor={isSelected ? new Color(0.96, 0.62, 0.04, 0.95) : new Color(0.1, 0.1, 0.1, 0.8)}
                pixelOffset={new Cartesian2(15, 0)}
                horizontalOrigin={HorizontalOrigin.LEFT}
                verticalOrigin={VerticalOrigin.CENTER}
              />
            </Entity>

            {/* Smart Focus Coverage Footprint */}
            {showFootprint && (
              <Entity
                name={`${gs.name} Coverage Footprint`}
                position={Cartesian3.fromDegrees(gs.longitude, gs.latitude, 0)}
              >
                <EllipseGraphics
                  semiMajorAxis={radiusMeters}
                  semiMinorAxis={radiusMeters}
                  material={
                    isSelected
                      ? Color.fromCssColorString('rgba(250, 204, 21, 0.18)')
                      : Color.fromCssColorString('rgba(245, 158, 11, 0.05)')
                  }
                  outline={true}
                  outlineColor={
                    isSelected
                      ? Color.fromCssColorString('rgba(250, 204, 21, 0.85)')
                      : Color.fromCssColorString('rgba(245, 158, 11, 0.25)')
                  }
                  outlineWidth={isSelected ? 2 : 1}
                />
              </Entity>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
};
