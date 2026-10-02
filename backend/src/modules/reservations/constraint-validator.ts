import { db } from "../../db/client";
import { missionTasks, contactWindows, reservations, groundStations } from "../../db/schema";
import { eq, and, or, lt, gt, ne } from "drizzle-orm";
import { ReservationRequest, ValidationResult, ValidationError } from "./types";

export class ConstraintValidationService {
  async validate(req: ReservationRequest, tx: any = db): Promise<ValidationResult> {
    const errors: ValidationError[] = [];

    // Basic time validation
    if (req.endTime <= req.startTime) {
      errors.push({
        code: "INVALID_TIME_RANGE",
        message: "endTime must be after startTime",
      });
      // We can't do meaningful overlap checks if the time is fundamentally broken
      return { valid: false, errors };
    }

    // 1. Task exists
    const taskResult = await tx.select().from(missionTasks).where(eq(missionTasks.id, req.taskId));
    const task = taskResult[0];
    if (!task) {
      errors.push({ code: "TASK_NOT_FOUND", message: "Mission task not found." });
    }

    // 2. Contact window exists
    const cwResult = await tx.select().from(contactWindows).where(eq(contactWindows.id, req.contactWindowId));
    const cw = cwResult[0];
    if (!cw) {
      errors.push({ code: "CONTACT_WINDOW_NOT_FOUND", message: "Contact window not found." });
    }

    if (!task || !cw) {
      // Cannot proceed with relational checks if entities don't exist
      return { valid: false, errors };
    }

    // 2b. Ground station exists
    const gsResult = await tx.select().from(groundStations).where(eq(groundStations.id, cw.groundStationId));
    const gs = gsResult[0];
    if (!gs) {
      errors.push({ code: "GROUND_STATION_NOT_FOUND", message: "Ground station not found." });
      return { valid: false, errors };
    }

    // 3. Satellite matches
    if (task.satelliteId !== cw.satelliteId) {
      errors.push({
        code: "SATELLITE_MISMATCH",
        message: "The task's satellite does not match the contact window's satellite.",
      });
    }
    if (req.satelliteId && req.satelliteId !== cw.satelliteId) {
      errors.push({
        code: "SATELLITE_MISMATCH",
        message: "Requested satelliteId does not match the contact window's satellite.",
      });
    }

    // 4. Ground station matches
    if (req.groundStationId && req.groundStationId !== cw.groundStationId) {
      errors.push({
        code: "GROUND_STATION_MISMATCH",
        message: "Requested groundStationId does not match the contact window's ground station.",
      });
    }

    // 4b. RF Frequency Band Compatibility (Phase 4.1)
    if (task.requiredFrequencyBand && gs.supportedFrequencyBands && gs.supportedFrequencyBands.length > 0) {
      if (!gs.supportedFrequencyBands.includes(task.requiredFrequencyBand)) {
        errors.push({
          code: "INCOMPATIBLE_FREQUENCY_BAND",
          message: `Task requires '${task.requiredFrequencyBand}', but station '${gs.name}' only supports [${gs.supportedFrequencyBands.join(", ")}].`,
        });
      }
    }

    // 4c. Data Rate Compatibility (Phase 4.1 per-contact requirement)
    if (task.minDataRateMbps && gs.maxDataRateMbps) {
      if (task.minDataRateMbps > gs.maxDataRateMbps) {
        errors.push({
          code: "INSUFFICIENT_STATION_DATA_RATE",
          message: `Task requires min data rate ${task.minDataRateMbps} Mbps, exceeding station maximum of ${gs.maxDataRateMbps} Mbps.`,
        });
      }
    }

    // 5 & 6. AOS / LOS
    if (req.startTime < cw.aos || req.endTime > cw.los) {
      errors.push({
        code: "OUTSIDE_CONTACT_WINDOW",
        message: "Reservation must remain within AOS/LOS.",
      });
    }

    // 7. Duration sufficient
    const requestedDurationSeconds = (req.endTime.getTime() - req.startTime.getTime()) / 1000;
    if (requestedDurationSeconds < task.durationSeconds) {
      errors.push({
        code: "DURATION_UNSATISFIED",
        message: `Requested duration (${requestedDurationSeconds}s) is less than the task requirement (${task.durationSeconds}s).`,
      });
    }

    // 8. Deadline satisfied
    if (req.endTime > task.deadline) {
      errors.push({
        code: "DEADLINE_MISSED",
        message: "Reservation end time is past the task deadline.",
      });
    }

    // 9 & 10. Conflict and Concurrent Capacity checks
    // We check for any active reservation (not CANCELLED or FAILED) that overlaps with [req.startTime, req.endTime).
    // An overlap occurs when: existing.start < new.end AND existing.end > new.start
    const overlappingReservations = await tx.select().from(reservations).where(
      and(
        lt(reservations.allocatedStart, req.endTime),
        gt(reservations.allocatedEnd, req.startTime),
        ne(reservations.status, "CANCELLED"),
        ne(reservations.status, "FAILED"),
        or(
          eq(reservations.satelliteId, cw.satelliteId),
          eq(reservations.groundStationId, cw.groundStationId)
        )
      )
    );

    let satelliteConflict = false;
    const overlappingStationReservations = overlappingReservations.filter(
      (resv: any) => resv.groundStationId === cw.groundStationId
    );

    for (const resv of overlappingReservations) {
      if (resv.satelliteId === cw.satelliteId) {
        satelliteConflict = true;
      }
    }

    if (satelliteConflict) {
      errors.push({
        code: "SATELLITE_CONFLICT",
        message: "The satellite is already reserved during this time.",
      });
    }

    const stationCapacity = gs.maxConcurrentContacts ?? 1;
    if (overlappingStationReservations.length >= stationCapacity) {
      errors.push({
        code: "STATION_CONFLICT",
        message: "The ground station is already reserved during this time.",
      });
      errors.push({
        code: "GROUND_STATION_CAPACITY_EXCEEDED",
        message: `Ground station has reached maximum concurrent contacts capacity (${stationCapacity}).`,
      });
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

export const constraintValidator = new ConstraintValidationService();
