import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { dispatchAttempts, reservations } from "../../db/schema";
import { providerRegistry } from "./provider.registry";
import { DispatchContext } from "./provider.types";
import { logger } from "../../config/logger";

export interface ReconciliationResult {
  readonly reconciled: boolean;
  readonly outcome: "STAGED_ACK" | "ARMED" | "UNKNOWN" | "REJECTED";
  readonly details?: Record<string, unknown>;
}

export class ProviderReconciliationService {
  /**
   * Reconcile an ambiguous outcome after provider timeout.
   * Invariant: Ambiguous timeout does NOT mean rejection or failure.
   * Status polling determines external state without creating duplicate dispatches.
   */
  async reconcileAmbiguousDispatch(
    dispatchId: string,
    providerId: string,
    context: DispatchContext
  ): Promise<ReconciliationResult> {
    const attemptRows = await db
      .select()
      .from(dispatchAttempts)
      .where(eq(dispatchAttempts.dispatchId, dispatchId));

    if (attemptRows.length === 0) {
      throw new Error(`Dispatch attempt [${dispatchId}] not found for reconciliation`);
    }

    const attempt = attemptRows[0]!;
    const adapter = providerRegistry.getAdapter(providerId);

    if (!adapter.pollPassStatus) {
      logger.warn({ dispatchId, providerId }, "Provider does not support status polling");
      return { reconciled: false, outcome: "UNKNOWN" };
    }

    try {
      const snapshot = await adapter.pollPassStatus(dispatchId, context);
      logger.info({ dispatchId, state: snapshot.state }, "Provider status snapshot obtained");

      if (snapshot.state === "STAGED") {
        // External provider did receive and stage the pass!
        // Transition attempt to STAGED_ACK, clear communication gap
        await db
          .update(dispatchAttempts)
          .set({
            state: "STAGED_ACK",
            transportHealth: "CONNECTED",
            stagedAt: snapshot.lastContactAt || new Date(),
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(dispatchAttempts.id, attempt.id));

        return { reconciled: true, outcome: "STAGED_ACK", details: snapshot as any };
      }

      if (snapshot.state === "ARMED" || snapshot.state === "TRACKING") {
        // External provider armed the pass!
        await db
          .update(dispatchAttempts)
          .set({
            state: "ARMED",
            transportHealth: "CONNECTED",
            armedAt: new Date(),
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(dispatchAttempts.id, attempt.id));

        await db
          .update(reservations)
          .set({
            executionState: "DISPATCHED",
            activeDispatchId: dispatchId,
            updatedAt: new Date(),
          })
          .where(eq(reservations.id, attempt.reservationId));

        return { reconciled: true, outcome: "ARMED", details: snapshot as any };
      }

      return { reconciled: false, outcome: "UNKNOWN", details: snapshot as any };
    } catch (err: any) {
      logger.error({ dispatchId, error: err.message }, "Error during provider status polling reconciliation");
      return { reconciled: false, outcome: "UNKNOWN" };
    }
  }
}

export const providerReconciliationService = new ProviderReconciliationService();
