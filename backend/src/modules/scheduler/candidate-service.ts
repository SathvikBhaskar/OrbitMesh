import { db } from "../../db/client";
import { contactWindows, reservations, satelliteOrbitalData } from "../../db/schema";
import { eq, and, lt, gt, inArray, asc, desc } from "drizzle-orm";

export class CandidateService {
  async findCandidateWindows(satelliteId: string, deadline: Date) {
    const latestOrbital = await db
      .select({ id: satelliteOrbitalData.id })
      .from(satelliteOrbitalData)
      .where(eq(satelliteOrbitalData.satelliteId, satelliteId))
      .orderBy(desc(satelliteOrbitalData.tleEpoch))
      .limit(1);

    const conditions = [
      eq(contactWindows.satelliteId, satelliteId),
      lt(contactWindows.aos, deadline),
    ];

    if (latestOrbital[0]) {
      conditions.push(eq(contactWindows.orbitalDataId, latestOrbital[0].id));
    }

    return await db.select()
      .from(contactWindows)
      .where(and(...conditions))
      .orderBy(asc(contactWindows.aos));
  }

  async hasAnyWindow(satelliteId: string): Promise<boolean> {
    const latestOrbital = await db
      .select({ id: satelliteOrbitalData.id })
      .from(satelliteOrbitalData)
      .where(eq(satelliteOrbitalData.satelliteId, satelliteId))
      .orderBy(desc(satelliteOrbitalData.tleEpoch))
      .limit(1);

    const conditions = [eq(contactWindows.satelliteId, satelliteId)];
    if (latestOrbital[0]) {
      conditions.push(eq(contactWindows.orbitalDataId, latestOrbital[0].id));
    }

    const res = await db.select({ id: contactWindows.id })
      .from(contactWindows)
      .where(and(...conditions))
      .limit(1);
    return res.length > 0;
  }

  async getRelevantActiveReservations(groundStationId: string, windowAos: Date, windowLos: Date) {
    return await db.select({
      allocatedStart: reservations.allocatedStart,
      allocatedEnd: reservations.allocatedEnd,
    })
    .from(reservations)
    .where(
      and(
        eq(reservations.groundStationId, groundStationId),
        inArray(reservations.status, ["PENDING", "CONFIRMED"]),
        gt(reservations.allocatedEnd, windowAos),
        lt(reservations.allocatedStart, windowLos)
      )
    )
    .orderBy(asc(reservations.allocatedStart));
  }

  findEarliestFeasibleInterval(
    windowAos: Date,
    windowLos: Date,
    taskDurationSeconds: number,
    taskDeadline: Date,
    existingReservations: { allocatedStart: Date, allocatedEnd: Date }[]
  ): { status: "SUCCESS", start: Date, end: Date } | { status: "FAILED", reason: "NO_FEASIBLE_WINDOW" | "DEADLINE_EXCEEDED" } {
    let cursor = windowAos.getTime();
    const durationMs = taskDurationSeconds * 1000;

    for (const res of existingReservations) {
      if (cursor + durationMs <= res.allocatedStart.getTime()) {
        if (cursor + durationMs <= taskDeadline.getTime()) {
          return { status: "SUCCESS", start: new Date(cursor), end: new Date(cursor + durationMs) };
        } else {
          return { status: "FAILED", reason: "DEADLINE_EXCEEDED" };
        }
      }
      cursor = Math.max(cursor, res.allocatedEnd.getTime());
    }

    if (cursor + durationMs <= windowLos.getTime()) {
      if (cursor + durationMs <= taskDeadline.getTime()) {
        return { status: "SUCCESS", start: new Date(cursor), end: new Date(cursor + durationMs) };
      } else {
        return { status: "FAILED", reason: "DEADLINE_EXCEEDED" };
      }
    }

    return { status: "FAILED", reason: "NO_FEASIBLE_WINDOW" };
  }
}
