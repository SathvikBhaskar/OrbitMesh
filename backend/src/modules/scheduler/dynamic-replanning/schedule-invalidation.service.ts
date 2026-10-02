import { db } from "../../../db/client";
import { reservations, contactWindows, missionTasks, satelliteOrbitalData } from "../../../db/schema";
import { eq, inArray, and, or, sql, desc } from "drizzle-orm";

export interface ReservationWithMeta {
  id: string;
  missionTaskId: string;
  contactWindowId: string;
  groundStationId: string;
  satelliteId: string;
  windowAos: Date;
  windowLos: Date;
  allocatedStart: Date;
  allocatedEnd: Date;
  taskDurationSeconds: number;
  status: string;
  source: string;
  locked: boolean;
}

export interface WindowWithBounds {
  id: string;
  groundStationId: string;
  satelliteId: string;
  aos: Date;
  los: Date;
  durationSeconds: number;
}

export interface InvalidationAnalysisResult {
  totalActiveReservations: number;
  exposedReservationsCount: number;
  sre: number; // Satellite Reservation Exposure: exposed / total
  invalidatedReservationIds: string[];
  affectedTaskIds: string[];
  slideableReservationIds: string[];
  ir: number; // Invalidation Rate: invalidated / total
  isBoundSatisfied: boolean; // IR <= SRE
  details: {
    reservationId: string;
    missionTaskId: string;
    satelliteId: string;
    groundStationId: string;
    allocatedStart: Date;
    allocatedEnd: Date;
    reason: "NO_SUPPORTING_WINDOW" | "WINDOW_BOUNDARY_BREACH" | "PASS_DISAPPEARED";
  }[];
}

export class ScheduleInvalidationService {
  /**
   * Analyzes the active schedule against the newly available contact windows
   * following an orbital TLE update for satelliteIds in `updatedSatelliteIds`.
   */
  public async analyzeImpact(
    updatedSatelliteIds: string[],
    referenceTime: Date = new Date()
  ): Promise<InvalidationAnalysisResult> {
    const updatedSatSet = new Set(updatedSatelliteIds);

    // 1. Fetch all active reservations (PENDING or CONFIRMED)
    const activeReservations = await db
      .select()
      .from(reservations)
      .where(
        and(
          inArray(reservations.status, ["PENDING", "CONFIRMED"]),
          sql`${reservations.allocatedEnd} >= ${referenceTime}`
        )
      );

    const totalActive = activeReservations.length;
    if (totalActive === 0 || updatedSatelliteIds.length === 0) {
      return {
        totalActiveReservations: totalActive,
        exposedReservationsCount: 0,
        sre: 0,
        invalidatedReservationIds: [],
        affectedTaskIds: [],
        slideableReservationIds: [],
        ir: 0,
        isBoundSatisfied: true,
        details: [],
      };
    }

    // 2. Identify exposed reservations: r.satelliteId in updatedSatSet
    const exposedReservations = activeReservations.filter((r) =>
      updatedSatSet.has(r.satelliteId)
    );
    const sreCount = exposedReservations.length;
    const sre = totalActive > 0 ? sreCount / totalActive : 0;

    // 3. Fetch candidate contact windows for updated satellites from their latest orbital data snapshot
    const latestSnapshots = await db
      .select({
        satelliteId: satelliteOrbitalData.satelliteId,
        id: satelliteOrbitalData.id,
      })
      .from(satelliteOrbitalData)
      .where(inArray(satelliteOrbitalData.satelliteId, updatedSatelliteIds))
      .orderBy(desc(satelliteOrbitalData.tleEpoch));

    const latestOdMap = new Map<string, string>();
    for (const snap of latestSnapshots) {
      if (!latestOdMap.has(snap.satelliteId)) {
        latestOdMap.set(snap.satelliteId, snap.id);
      }
    }
    const latestOdIds = Array.from(latestOdMap.values());

    const newWindows = latestOdIds.length > 0
      ? await db
          .select()
          .from(contactWindows)
          .where(
            and(
              inArray(contactWindows.orbitalDataId, latestOdIds),
              sql`${contactWindows.los} >= ${referenceTime}`
            )
          )
      : [];

    // Group windows by satelliteId + groundStationId
    const windowMap = new Map<string, WindowWithBounds[]>();
    for (const w of newWindows) {
      const key = `${w.satelliteId}_${w.groundStationId}`;
      const list = windowMap.get(key) || [];
      list.push({
        id: w.id,
        groundStationId: w.groundStationId,
        satelliteId: w.satelliteId,
        aos: new Date(w.aos),
        los: new Date(w.los),
        durationSeconds: w.durationSeconds,
      });
      windowMap.set(key, list);
    }

    const invalidatedIds: string[] = [];
    const affectedTaskIds = new Set<string>();
    const slideableIds: string[] = [];
    const details: InvalidationAnalysisResult["details"] = [];

    // 4. Evaluate physical validity of each exposed reservation
    for (const r of exposedReservations) {
      const key = `${r.satelliteId}_${r.groundStationId}`;
      const candidateWindows = windowMap.get(key) || [];

      const rStart = new Date(r.allocatedStart).getTime();
      const rEnd = new Date(r.allocatedEnd).getTime();
      const rDurationSec = r.taskDurationSeconds;

      let isValid = false;
      let isSlideable = false;
      let hasOverlappingWindow = false;

      for (const w of candidateWindows) {
        const wAos = w.aos.getTime();
        const wLos = w.los.getTime();

        // Check full physical containment: AOS <= allocatedStart AND allocatedEnd <= LOS
        if (wAos <= rStart && rEnd <= wLos) {
          isValid = true;
          break; // Fully supported by this window
        }

        // Check if overlaps partially
        if (Math.max(wAos, rStart) < Math.min(wLos, rEnd)) {
          hasOverlappingWindow = true;
        }

        // Check if slideable: does window duration accommodate task duration?
        if (w.durationSeconds >= rDurationSec) {
          isSlideable = true;
        }
      }

      if (!isValid) {
        invalidatedIds.push(r.id);
        affectedTaskIds.add(r.missionTaskId);

        if (isSlideable) {
          slideableIds.push(r.id);
        }

        const reason =
          candidateWindows.length === 0
            ? "PASS_DISAPPEARED"
            : hasOverlappingWindow
            ? "WINDOW_BOUNDARY_BREACH"
            : "NO_SUPPORTING_WINDOW";

        details.push({
          reservationId: r.id,
          missionTaskId: r.missionTaskId,
          satelliteId: r.satelliteId,
          groundStationId: r.groundStationId,
          allocatedStart: new Date(r.allocatedStart),
          allocatedEnd: new Date(r.allocatedEnd),
          reason,
        });
      }
    }

    const ir = totalActive > 0 ? invalidatedIds.length / totalActive : 0;
    const isBoundSatisfied = ir <= sre + 1e-9; // IR <= SRE within floating point tolerance

    return {
      totalActiveReservations: totalActive,
      exposedReservationsCount: sreCount,
      sre,
      invalidatedReservationIds: invalidatedIds,
      affectedTaskIds: Array.from(affectedTaskIds),
      slideableReservationIds: slideableIds,
      ir,
      isBoundSatisfied,
      details,
    };
  }
}
