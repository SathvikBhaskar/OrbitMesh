import React from 'react';
import { Entity, EllipseGraphics } from 'resium';
import { Cartesian3, Color } from 'cesium';
import { MissionTask, SatellitePosition } from './map-types';

interface TaskLayerProps {
  tasks: MissionTask[];
  satellites: SatellitePosition[];
}

export const TaskLayer: React.FC<TaskLayerProps> = ({ tasks, satellites }) => {
  // Highlight satellites assigned to active or scheduled mission tasks
  const relevantTasks = tasks.filter(t => t.status === 'SCHEDULED' || t.status === 'IN_PROGRESS');

  return (
    <>
      {relevantTasks.map((t) => {
        const sat = satellites.find(s => s.satelliteId === t.satelliteId);
        if (!sat) return null;

        // Draw a highlighting halo (ellipse) indicating satellite mission task assignment
        return (
          <Entity
            key={`halo-${t.id}`}
            position={Cartesian3.fromDegrees(sat.longitude, sat.latitude, 0)} // Ground footprint projection
          >
            <EllipseGraphics
              semiMinorAxis={400000.0} // 400km sensor footprint
              semiMajorAxis={400000.0}
              material={Color.fromCssColorString('#6366f1').withAlpha(0.25)}
              outline={true}
              outlineColor={Color.fromCssColorString('#818cf8').withAlpha(0.6)}
            />
          </Entity>
        );
      })}
    </>
  );
};
