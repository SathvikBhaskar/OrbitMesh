import React from 'react';
import { Entity, EllipseGraphics } from 'resium';
import { Cartesian3, Color } from 'cesium';
import { MissionTask, SatellitePosition } from './map-types';

interface TaskLayerProps {
  tasks: MissionTask[];
  satellites: SatellitePosition[];
}

export const TaskLayer: React.FC<TaskLayerProps> = ({ tasks, satellites }) => {
  const activeTasks = tasks.filter(t => t.status === 'ACTIVE');

  return (
    <>
      {activeTasks.map((t) => {
        const sat = satellites.find(s => s.satelliteId === t.satelliteId);
        if (!sat) return null;

        // Draw a highlighting halo (ellipse) under the satellite indicating it is currently performing a task
        return (
          <Entity
            key={t.id}
            position={Cartesian3.fromDegrees(sat.longitude, sat.latitude, sat.altitudeKm * 1000)}
          >
            <EllipseGraphics
              semiMinorAxis={500000.0} // 500km radius
              semiMajorAxis={500000.0}
              material={Color.fromCssColorString('#ef4444').withAlpha(0.4)}
              outline={true}
              outlineColor={Color.fromCssColorString('#ef4444')}
            />
          </Entity>
        );
      })}
    </>
  );
};
