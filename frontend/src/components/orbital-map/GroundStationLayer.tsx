import React from 'react';
import { Entity, PointGraphics, LabelGraphics } from 'resium';
import { Cartesian3, Color, Cartesian2, HorizontalOrigin, VerticalOrigin } from 'cesium';
import { GroundStation } from './map-types';

interface GroundStationLayerProps {
  stations: GroundStation[];
  onSelect?: (station: GroundStation) => void;
}

export const GroundStationLayer: React.FC<GroundStationLayerProps> = ({ stations, onSelect }) => {
  return (
    <>
      {stations.map((gs) => {
        return (
          <Entity
            key={gs.id}
            name={gs.name}
            position={Cartesian3.fromDegrees(gs.longitude, gs.latitude, gs.altitudeM)}
            description={`Code: ${gs.code}<br>Elevation: ${gs.altitudeM} m<br>Min Elev: ${gs.minimumElevationDeg}°`}
            onClick={() => onSelect?.(gs)}
          >
            <PointGraphics
              pixelSize={12}
              color={Color.fromCssColorString('#f59e0b')}
              outlineColor={Color.WHITE}
              outlineWidth={2}
            />
            <LabelGraphics
              text={gs.code}
              font="10px sans-serif"
              fillColor={Color.WHITE}
              showBackground={true}
              backgroundColor={new Color(0.1, 0.1, 0.1, 0.8)}
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
