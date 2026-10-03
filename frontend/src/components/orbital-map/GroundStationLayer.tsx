import React from 'react';
import { Entity, PointGraphics, LabelGraphics } from 'resium';
import { Cartesian3, Color, Cartesian2, HorizontalOrigin, VerticalOrigin } from 'cesium';
import { GroundStation } from './map-types';

interface GroundStationLayerProps {
  stations: GroundStation[];
  selectedStationId?: string;
  onSelect?: (station: GroundStation) => void;
  onDoubleClick?: (station: GroundStation) => void;
}

export const GroundStationLayer: React.FC<GroundStationLayerProps> = ({
  stations,
  selectedStationId,
  onSelect,
  onDoubleClick
}) => {
  return (
    <>
      {stations.map((gs) => {
        const isSelected = gs.id === selectedStationId;
        return (
          <Entity
            key={gs.id}
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
        );
      })}
    </>
  );
};
