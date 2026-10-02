import { eq } from "drizzle-orm";
import crypto from "crypto";
import { db } from "../../db/client";
import { reservations, dispatchAttempts, users } from "../../db/schema";
import { providerRegistry } from "./provider.registry";
import { DispatchContext } from "./provider.types";
import { EventControlPlaneService } from "../scheduler/event-control-plane/event-control-plane.service";
import { logger } from "../../config/logger";

export interface AbortCommandResult {
  readonly status: "ABORT_CONFIRMED" | "ABORT_UNCONFIRMED" | "ABORT_FAILED";
  readonly physicalSilenced: boolean;
  readonly versionAdvanced: boolean;
  readonly warning?: string;
  readonly error?: string;
}

export class SafetyInterlockService {
  private eventControlPlaneService: EventControlPlaneService;

  constructor() {
    this.eventControlPlaneService = new EventControlPlaneService();
  }

  private async getOrCreateOperatorUserId(providedUserId?: string): Promise<string> {
    if (providedUserId) {
      const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, providedUserId));
      if (u) return u.id;
    }
    const [existing] = await db.select({ id: users.id }).from(users).limit(1);
    if (existing) {
      return existing.id;
    }
    const [created] = await db
      .insert(users)
      .values({
        email: `system-operator-${crypto.randomUUID().slice(0, 8)}@orbitmesh.internal`,
        passwordHash: "interlock-system-hash",
        role: "OPERATOR",
      })
      .returning({ id: users.id });
    if (!created) {
      throw new Error("Failed to create system operator user");
    }
    return created.id;
  }

  /**
   * Emergency Pass Abort Command (§5.1, §5.3):
   * Invariant:
   * ABORT_REQUESTED ≠ ABORT_CONFIRMED
   * ABORT_REQUESTED ≠ RF TRANSMISSION HALTED
   * Watchdog/Timeout produces ABORT_UNCONFIRMED (never manufactures false confirmation)
   * Only ABORT_CONFIRMED triggers Control Plane schedule version advancement (V_N -> V_N+1)
   */
  async commandPassAbort(
    reservationId: string,
    reason: string = "OPERATOR_EMERGENCY_ABORT",
    options: {
      providerId?: string;
      stationCode?: string;
      userId?: string;
    } = {}
  ): Promise<AbortCommandResult> {
    const resRows = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, reservationId));

    if (resRows.length === 0) {
      throw new Error(`Reservation [${reservationId}] not found for emergency abort`);
    }

    const res = resRows[0]!;
    const providerId = options.providerId || "default-provider";
    const dispatchId = res.activeDispatchId || "unknown-dispatch";

    // 1. Mark command requested: ABORT_REQUESTED
    await db
      .update(reservations)
      .set({
        executionInterlock: "ABORT_REQUESTED",
        interlockRequestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(reservations.id, reservationId));

    logger.warn(
      { reservationId, dispatchId, reason },
      "[SAFETY_INTERLOCK] Emergency pass abort commanded: ABORT_REQUESTED"
    );

    const context: DispatchContext = {
      dispatchId,
      attemptNumber: 1,
      idempotencyKey: `abort-${reservationId}-${Date.now()}`,
      correlationId: `corr-abort-${crypto.randomUUID().slice(0, 8)}`,
      providerId,
      stationCode: options.stationCode || "GS-STATION",
    };

    // 2. Dispatch high-priority abort command to provider adapter
    try {
      const adapter = providerRegistry.getAdapter(providerId);
      const receipt = await adapter.abortPass(dispatchId, reason, context);

      if (receipt.rfCarrierSilenced) {
        // Physical confirmation received from ground station!
        await db
          .update(reservations)
          .set({
            executionInterlock: "ABORT_CONFIRMED",
            interlockConfirmedAt: receipt.confirmedAt || new Date(),
            executionState: "FAILED",
            failureReason: "EXECUTION_ABORTED",
            updatedAt: new Date(),
          })
          .where(eq(reservations.id, reservationId));

        logger.info(
          { reservationId, dispatchId },
          "[SAFETY_INTERLOCK] Physical abort confirmed: ABORT_CONFIRMED. Transitioning reservation to FAILED"
        );

        // 3. Authoritative scheduling consequence -> Advance schedule version via Control Plane
        const operatorUserId = await this.getOrCreateOperatorUserId(options.userId);
        await this.eventControlPlaneService.ingestEvents(
          [
            {
              idempotencyKey: `abort-rescue-${reservationId}-${Date.now()}`,
              eventType: "CAPACITY_RELEASE",
              payload: {
                releasedReservationId: reservationId,
                reason: `EMERGENCY_ABORT_CONFIRMED: ${reason}`,
              },
            },
          ],
          {
            userId: operatorUserId,
            referenceTime: new Date(),
          }
        );

        // Re-assert physical confirmation on reservation execution state
        await db
          .update(reservations)
          .set({
            executionInterlock: "ABORT_CONFIRMED",
            interlockConfirmedAt: receipt.confirmedAt || new Date(),
            executionState: "FAILED",
            failureReason: "EXECUTION_ABORTED",
            updatedAt: new Date(),
          })
          .where(eq(reservations.id, reservationId));

        return {
          status: "ABORT_CONFIRMED",
          physicalSilenced: true,
          versionAdvanced: true,
        };
      } else {
        // Provider responded but did not confirm silencing
        await db
          .update(reservations)
          .set({
            executionInterlock: "ABORT_UNCONFIRMED",
            updatedAt: new Date(),
          })
          .where(eq(reservations.id, reservationId));

        return {
          status: "ABORT_UNCONFIRMED",
          physicalSilenced: false,
          versionAdvanced: false,
          warning: "Provider acknowledged abort request but could not confirm RF carrier silenced",
        };
      }
    } catch (err: any) {
      // 4. Timeout / communication gap / network error:
      // Invariant: Do NOT manufacture false physical confirmation!
      // Transitions to ABORT_UNCONFIRMED; version remains V_N -> V_N
      await db
        .update(reservations)
        .set({
          executionInterlock: "ABORT_UNCONFIRMED",
          updatedAt: new Date(),
        })
        .where(eq(reservations.id, reservationId));

      logger.error(
        { reservationId, error: err.message },
        "[SAFETY_INTERLOCK] Abort command timed out or encountered communication gap: ABORT_UNCONFIRMED"
      );

      return {
        status: "ABORT_UNCONFIRMED",
        physicalSilenced: false,
        versionAdvanced: false,
        warning: `ABORT UNCONFIRMED - LINK SILENT: ${err.message}`,
        error: err.message,
      };
    }
  }

  /**
   * RF Carrier Inhibit Command (§5.1, §6 Scenario O)
   */
  async commandRfInhibit(
    reservationId: string,
    stationId: string,
    reason: string = "REGULATORY_RF_INHIBIT",
    options: { providerId?: string } = {}
  ): Promise<{ status: string; carrierInhibited: boolean }> {
    await db
      .update(reservations)
      .set({
        executionInterlock: "RF_INHIBIT_REQUESTED",
        interlockRequestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(reservations.id, reservationId));

    const providerId = options.providerId || "default-provider";
    const adapter = providerRegistry.getAdapter(providerId);

    const context: DispatchContext = {
      dispatchId: "rf-inhibit-cmd",
      attemptNumber: 1,
      idempotencyKey: `inhibit-${stationId}-${Date.now()}`,
      correlationId: `corr-inhibit-${crypto.randomUUID().slice(0, 8)}`,
      providerId,
      stationCode: "STATION",
    };

    const receipt = await adapter.abortPass("rf-inhibit-cmd", reason, context);

    if (receipt.rfCarrierSilenced) {
      await db
        .update(reservations)
        .set({
          executionInterlock: "RF_INHIBIT_CONFIRMED",
          interlockConfirmedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(reservations.id, reservationId));

      return { status: "RF_INHIBIT_CONFIRMED", carrierInhibited: true };
    }

    return { status: "RF_INHIBIT_REQUESTED", carrierInhibited: false };
  }
}

export const safetyInterlockService = new SafetyInterlockService();
