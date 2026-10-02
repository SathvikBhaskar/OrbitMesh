import { db } from "../../db/client";
import { satelliteOrbitalData, groundStations } from "../../db/schema";
import { eq, desc } from "drizzle-orm";
import { twoline2satrec, propagate, gstime, eciToEcf, ecfToLookAngles } from "satellite.js";
import { VisibilitySample } from "./types";

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function radiansToDegrees(radians: number): number {
  return radians * 180 / Math.PI;
}

import { TelemetrySink } from "../../utils/telemetry";

export class VisibilityService {
  async getVisibility(satelliteId: string, groundStationId: string, start: Date, end: Date, stepSeconds: number, telemetry?: TelemetrySink) {
    const t0 = performance.now();
    // Fetch historical orbital data
    const historicalData = await db
      .select()
      .from(satelliteOrbitalData)
      .where(eq(satelliteOrbitalData.satelliteId, satelliteId))
      .orderBy(desc(satelliteOrbitalData.tleEpoch))
      .limit(1);

    if (historicalData.length === 0) {
      throw new Error(`No orbital data found for satellite ${satelliteId}`);
    }

    const tle = historicalData[0]!;

    // Fetch ground station
    const stations = await db
      .select()
      .from(groundStations)
      .where(eq(groundStations.id, groundStationId));

    if (stations.length === 0) {
      throw new Error(`Ground station ${groundStationId} not found`);
    }

    const station = stations[0]!;
    const minElevation = station.minimumElevationDeg;

    const observerGd = {
      longitude: degreesToRadians(station.longitude),
      latitude: degreesToRadians(station.latitude),
      height: station.altitudeM / 1000 // Convert meters to km
    };

    const satrec = twoline2satrec(tle.tleLine1, tle.tleLine2);

    const samples: VisibilitySample[] = [];
    
    // Safety check on times and steps
    if (start.getTime() > end.getTime()) {
      throw new Error("Start time must be before end time");
    }
    if (stepSeconds <= 0) {
      throw new Error("Step seconds must be greater than 0");
    }

    let currentTime = start.getTime();
    const endTime = end.getTime();

    // Prevent infinite loops or memory explosions
    if ((endTime - currentTime) / (stepSeconds * 1000) > 100000) {
      throw new Error("Too many samples requested");
    }

    const tPropStart = performance.now();
    while (currentTime <= endTime) {
      const currentDate = new Date(currentTime);
      
      const posVel = propagate(satrec, currentDate);
      
      let sampleResult: VisibilitySample;
      
      if (!posVel || !posVel.position) {
         // satellite.js could fail propagation (e.g. decayed)
         sampleResult = {
           timestamp: currentDate.toISOString(),
           elevationDeg: NaN,
           azimuthDeg: NaN,
           rangeKm: NaN,
           visible: false
         };
      } else {
         const positionEci = posVel.position as any;
         
         // If satellite.js returns boolean on failure instead of position object
         if (typeof positionEci === 'boolean' || isNaN(positionEci.x)) {
           sampleResult = {
             timestamp: currentDate.toISOString(),
             elevationDeg: NaN,
             azimuthDeg: NaN,
             rangeKm: NaN,
             visible: false
           };
         } else {
           const gmst = gstime(currentDate);
           const positionEcf = eciToEcf(positionEci, gmst);
           const lookAngles = ecfToLookAngles(observerGd, positionEcf);

           const elevationDeg = radiansToDegrees(lookAngles.elevation);
           const azimuthDeg = radiansToDegrees(lookAngles.azimuth);
           const rangeKm = lookAngles.rangeSat;
           
           let visible = false;
           // Only consider visible if elevation is valid and >= minimum
           if (Number.isFinite(elevationDeg) && elevationDeg >= minElevation) {
               visible = true;
           }

           sampleResult = {
             timestamp: currentDate.toISOString(),
             elevationDeg,
             azimuthDeg,
             rangeKm,
             visible
           };
         }
      }

      samples.push(sampleResult);
      currentTime += stepSeconds * 1000;
    }
    
    if (telemetry) {
      telemetry.recordTime("propagation", performance.now() - tPropStart);
    }

    return {
      satelliteId,
      groundStationId,
      samples
    };
  }
}
