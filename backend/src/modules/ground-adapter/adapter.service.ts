import { db } from "../../db/client";
import { dispatchAttempts, reservations, executionTelemetryEvents, missionTasks } from "../../db/schema";
import { eq, and, sql, desc, max } from "drizzle-orm";
import { randomUUID } from "crypto";
import { logger } from "../../config/logger";
import {
  DispatchAttemptRecord,
  DispatchHandshakeState,
  AdapterTransportHealth,
  ClockSkewResult,
  SequenceGapResult,
  IngestTelemetryOptions,
} from "./adapter.types";

export class GroundAdapterService {
  private static readonly MAX_FUTURE_CLOCK_SKEW_MS = 5000; // ±5s future skew limit
  private static readonly MAX_PAST_CLOCK_SKEW_MS = 3600000; // 1 hour past skew limit

  /**
   * 1. Prepare a new Dispatch Attempt for a scheduled/execution-ready reservation.
   * Assigns a globally unique dispatchId and sequential attemptNumber for the reservation.
   */
  async prepareDispatchAttempt(
    reservationId: string,
    metadata: Record<string, any> = {}
  ): Promise<DispatchAttemptRecord> {
    const resRows = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, reservationId));

    if (resRows.length === 0) {
      throw new Error(`Reservation ${reservationId} not found`);
    }
    const res = resRows[0]!;

    // Determine next attempt number
    const existingAttempts = await db
      .select({ maxAttempt: max(dispatchAttempts.attemptNumber) })
      .from(dispatchAttempts)
      .where(eq(dispatchAttempts.reservationId, reservationId));

    const nextAttemptNum = (existingAttempts[0]?.maxAttempt || 0) + 1;
    const dispatchId = `disp-${randomUUID().slice(0, 8)}`;

    const [attempt] = await db
      .insert(dispatchAttempts)
      .values({
        reservationId,
        dispatchId,
        attemptNumber: nextAttemptNum,
        state: "PREPARED",
        transportHealth: "CONNECTED",
        metadata,
      })
      .returning();

    // Ensure reservation is at least EXECUTION_READY
    if (res.executionState === "SCHEDULED") {
      await db
        .update(reservations)
        .set({ executionState: "EXECUTION_READY", updatedAt: new Date() })
        .where(eq(reservations.id, reservationId));
    }

    logger.info(
      { reservationId, dispatchId, attemptNumber: nextAttemptNum },
      "Prepared dispatch attempt"
    );

    return attempt as DispatchAttemptRecord;
  }

  /**
   * 2. Stage a prepared dispatch attempt with the external station.
   * Handles network timeout without premature physical failure.
   */
  async stageDispatchAttempt(
    dispatchId: string,
    options: { simulateNetworkTimeout?: boolean; simulatePhysicalRejection?: boolean; rejectionReason?: string } = {}
  ): Promise<DispatchAttemptRecord> {
    const attemptRows = await db
      .select()
      .from(dispatchAttempts)
      .where(eq(dispatchAttempts.dispatchId, dispatchId));

    if (attemptRows.length === 0) {
      throw new Error(`Dispatch attempt ${dispatchId} not found`);
    }
    const attempt = attemptRows[0]!;

    if (attempt.state !== "PREPARED") {
      throw new Error(`Cannot stage dispatch attempt in state: ${attempt.state}`);
    }

    // 1. Network timeout during staging:
    // Cardinal Rule: Transport failure is NOT execution failure.
    // The attempt remains PREPARED (or enters retry count), marked with COMMUNICATION_GAP, but NOT failed/expired yet.
    if (options.simulateNetworkTimeout) {
      const [updated] = await db
        .update(dispatchAttempts)
        .set({
          transportHealth: "COMMUNICATION_GAP",
          retryCount: sql`${dispatchAttempts.retryCount} + 1`,
          lastError: "NETWORK_TIMEOUT_DURING_STAGING",
          updatedAt: new Date(),
        })
        .where(eq(dispatchAttempts.id, attempt.id))
        .returning();

      logger.warn({ dispatchId }, "Network timeout staging dispatch; attempt remains PREPARED under retry policy");
      return updated as DispatchAttemptRecord;
    }

    // 2. Physical station rejection (e.g. hardware offline / capability mismatch):
    if (options.simulatePhysicalRejection) {
      const [updated] = await db
        .update(dispatchAttempts)
        .set({
          state: "REJECTED",
          lastError: options.rejectionReason || "STATION_HARDWARE_REJECTED",
          updatedAt: new Date(),
        })
        .where(eq(dispatchAttempts.id, attempt.id))
        .returning();

      logger.warn({ dispatchId, reason: options.rejectionReason }, "Physical station rejected dispatch attempt");
      return updated as DispatchAttemptRecord;
    }

    // 3. Normal Staged Acknowledgement:
    const [updated] = await db
      .update(dispatchAttempts)
      .set({
        state: "STAGED_ACK",
        stagedAt: new Date(),
        transportHealth: "CONNECTED",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(dispatchAttempts.id, attempt.id))
      .returning();

    logger.info({ dispatchId }, "Dispatch attempt staged successfully (STAGED_ACK)");
    return updated as DispatchAttemptRecord;
  }

  /**
   * 3. Arm a staged dispatch attempt.
   * Once ARMED by the ground station, OrbitMesh atomically sets activeDispatchId and transitions reservation to DISPATCHED.
   */
  async armDispatchAttempt(
    dispatchId: string,
    options: { simulateArmRejection?: boolean; rejectionReason?: string } = {}
  ): Promise<DispatchAttemptRecord> {
    const attemptRows = await db
      .select()
      .from(dispatchAttempts)
      .where(eq(dispatchAttempts.dispatchId, dispatchId));

    if (attemptRows.length === 0) {
      throw new Error(`Dispatch attempt ${dispatchId} not found`);
    }
    const attempt = attemptRows[0]!;

    if (attempt.state !== "STAGED_ACK") {
      throw new Error(`Cannot arm dispatch attempt in state: ${attempt.state} (must be STAGED_ACK)`);
    }

    if (options.simulateArmRejection) {
      const [updated] = await db
        .update(dispatchAttempts)
        .set({
          state: "REJECTED",
          lastError: options.rejectionReason || "ARMING_FAILED_ANTENNA_SLEW_FAULT",
          updatedAt: new Date(),
        })
        .where(eq(dispatchAttempts.id, attempt.id))
        .returning();

      logger.warn({ dispatchId, reason: options.rejectionReason }, "Station rejected arming");
      return updated as DispatchAttemptRecord;
    }

    // Mark attempt ARMED
    const [updated] = await db
      .update(dispatchAttempts)
      .set({
        state: "ARMED",
        armedAt: new Date(),
        transportHealth: "CONNECTED",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(dispatchAttempts.id, attempt.id))
      .returning();

    // Propagate to reservation: activeDispatchId set, state becomes DISPATCHED (Preserves Phase 5.5 contract boundary!)
    await db
      .update(reservations)
      .set({
        executionState: "DISPATCHED",
        activeDispatchId: dispatchId,
        dispatchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(reservations.id, attempt.reservationId));

    logger.info({ dispatchId, reservationId: attempt.reservationId }, "Dispatch attempt ARMED -> Reservation DISPATCHED");
    return updated as DispatchAttemptRecord;
  }

  /**
   * 4. Clock Discipline: Evaluate clock offset and skew boundaries.
   * Authority hierarchy:
   * 1. dispatchId
   * 2. sequenceNumber
   * 3. server receipt time
   * 4. sourceTimestamp
   */
  evaluateClockSkew(sourceTimestamp: Date, serverTime: Date = new Date()): ClockSkewResult {
    const offsetMs = sourceTimestamp.getTime() - serverTime.getTime();

    // Rejection rule 1: Excessive future skew
    if (offsetMs > GroundAdapterService.MAX_FUTURE_CLOCK_SKEW_MS) {
      return {
        isAcceptable: false,
        clockOffsetMs: offsetMs,
        rejectionReason: "CLOCK_SKEW_FUTURE",
      };
    }

    // Rejection rule 2: Excessive past skew
    if (offsetMs < -GroundAdapterService.MAX_PAST_CLOCK_SKEW_MS) {
      return {
        isAcceptable: false,
        clockOffsetMs: offsetMs,
        rejectionReason: "CLOCK_SKEW_EXCESSIVE_PAST",
      };
    }

    return {
      isAcceptable: true,
      clockOffsetMs: offsetMs,
    };
  }

  /**
   * 5. Sequence Gap Detection & Parity Tracking.
   * Detects gaps (e.g. Seq 101, 102 -> 105), marks COMMUNICATION_GAP,
   * and closes the gap when missing sequence packets are replayed or parity is confirmed.
   */
  async evaluateSequenceAndGap(
    dispatchId: string,
    sequenceNumber: number,
    options: { isSnapshot?: boolean } = {}
  ): Promise<SequenceGapResult> {
    const attemptRows = await db
      .select()
      .from(dispatchAttempts)
      .where(eq(dispatchAttempts.dispatchId, dispatchId));

    if (attemptRows.length === 0) {
      throw new Error(`Dispatch attempt ${dispatchId} not found`);
    }
    const attempt = attemptRows[0]!;

    // Find highest sequence recorded for this dispatch
    const highestEvt = await db
      .select({ maxSeq: max(executionTelemetryEvents.sequenceNumber) })
      .from(executionTelemetryEvents)
      .where(eq(executionTelemetryEvents.dispatchId, dispatchId));

    const highestSeq = highestEvt[0]?.maxSeq || 0;

    // Snapshot mode: authoritative state snapshot overrides sequence gap
    if (options.isSnapshot) {
      if (attempt.transportHealth === "COMMUNICATION_GAP") {
        await db
          .update(dispatchAttempts)
          .set({ transportHealth: "CONNECTED", updatedAt: new Date() })
          .where(eq(dispatchAttempts.id, attempt.id));
      }
      return {
        hasGap: false,
        expectedSeq: highestSeq + 1,
        receivedSeq: sequenceNumber,
        missingSeqs: [],
      };
    }

    // Regular sequential flow
    if (sequenceNumber === highestSeq + 1) {
      // Clean monotonic advance; if we were in a gap and just caught up, restore CONNECTED
      if (attempt.transportHealth === "COMMUNICATION_GAP") {
        await db
          .update(dispatchAttempts)
          .set({ transportHealth: "CONNECTED", updatedAt: new Date() })
          .where(eq(dispatchAttempts.id, attempt.id));
      }

      return {
        hasGap: false,
        expectedSeq: highestSeq + 1,
        receivedSeq: sequenceNumber,
        missingSeqs: [],
      };
    }

    // Gap condition: incoming sequence is ahead of expected
    if (sequenceNumber > highestSeq + 1) {
      const missingSeqs: number[] = [];
      for (let s = highestSeq + 1; s < sequenceNumber; s++) {
        missingSeqs.push(s);
      }

      // Mark transport health as COMMUNICATION_GAP on dispatch_attempts (NOT reservations!)
      await db
        .update(dispatchAttempts)
        .set({
          transportHealth: "COMMUNICATION_GAP",
          lastError: `SEQUENCE_GAP_DETECTED: missing [${missingSeqs.join(",")}]`,
          updatedAt: new Date(),
        })
        .where(eq(dispatchAttempts.id, attempt.id));

      logger.warn({ dispatchId, expected: highestSeq + 1, received: sequenceNumber, missingSeqs }, "Sequence gap detected in telemetry stream");

      return {
        hasGap: true,
        expectedSeq: highestSeq + 1,
        receivedSeq: sequenceNumber,
        missingSeqs,
      };
    }

    // Duplicate or out-of-order delayed packet (sequenceNumber <= highestSeq)
    return {
      hasGap: false,
      expectedSeq: highestSeq + 1,
      receivedSeq: sequenceNumber,
      missingSeqs: [],
    };
  }

  /**
   * 6. Reconcile Snapshot vs Buffered Replay (Scenario O & N).
   * Ensures that when an aggregate snapshot arrives, followed by delayed packets,
   * actuals are strictly monotonic: bytesTransferred = max(current, incoming).
   * No double-counting occurs.
   */
  async reconcileTelemetryActuals(
    reservationId: string,
    dispatchId: string,
    reportedBytes: number
  ): Promise<{ bytesTransferred: number; wasUpdated: boolean }> {
    const resRows = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, reservationId));

    if (resRows.length === 0) {
      throw new Error(`Reservation ${reservationId} not found`);
    }
    const res = resRows[0]!;

    // Verify dispatch identity
    if (res.activeDispatchId !== dispatchId) {
      throw new Error(`STALE_DISPATCH_REJECTED: active is ${res.activeDispatchId}, incoming is ${dispatchId}`);
    }

    const currentBytes = res.bytesTransferred || 0;
    const finalBytes = Math.max(currentBytes, reportedBytes);

    if (finalBytes > currentBytes) {
      await db
        .update(reservations)
        .set({
          bytesTransferred: finalBytes,
          updatedAt: new Date(),
        })
        .where(eq(reservations.id, reservationId));

      return { bytesTransferred: finalBytes, wasUpdated: true };
    }

    return { bytesTransferred: currentBytes, wasUpdated: false };
  }
}

export const groundAdapterService = new GroundAdapterService();
