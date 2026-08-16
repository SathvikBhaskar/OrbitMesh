import { twoline2satrec, propagate } from "satellite.js";
import { PositionVelocity } from "./types";

export function propagateOrbit(tleLine1: string, tleLine2: string, timestamp: Date): PositionVelocity {
  // Validate timestamp
  if (isNaN(timestamp.getTime())) {
    throw new Error("Invalid timestamp for propagation");
  }

  const satrec = twoline2satrec(tleLine1, tleLine2);
  const positionAndVelocity = propagate(satrec, timestamp);
  
  if (!positionAndVelocity || !positionAndVelocity.position || !positionAndVelocity.velocity) {
    throw new Error("satellite.js propagation failed (no position/velocity returned)");
  }

  const position = positionAndVelocity.position as { x: number, y: number, z: number };
  const velocity = positionAndVelocity.velocity as { x: number, y: number, z: number };

  if (typeof position === 'boolean' || typeof velocity === 'boolean') {
    throw new Error("Propagation failed (returned boolean)");
  }

  // Ensure no NaN / Infinity
  const isFiniteCoords = (c: {x: number, y: number, z: number}) => 
    Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z);

  if (!isFiniteCoords(position) || !isFiniteCoords(velocity)) {
    throw new Error("Propagation produced NaN or Infinity coordinates");
  }

  return {
    position,
    velocity,
    timestamp
  };
}
