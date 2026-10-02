/**
 * OrbitMesh Phase 5.3 - Event Control Plane Service
 *
 * Implements:
 * 1. Event Processing Precedence (Level 1: Outage -> Level 2: Orbital -> Level 3: Preemption -> Level 4: Opportunity)
 * 2. Dispatch Urgency (IMMEDIATE vs COALESCIBLE)
 * 3. Idempotency Lifecycle & Database-Level Uniqueness
 * 4. Subsumption & Coalescing of Outage Intervals
 * 5. Single-Flight Serialized Batch Execution (Monotonic N -> N+1 version bump per batch)
 * 6. Interrupted Batch Recovery / Idempotent Retry
 * 7. Delegation to existing execution mechanisms (Phase 5.1 & Phase 5.2)
 */

import { db, txContext } from "../../../db/client";
import {
  operationalEventLedger,
  operationalBatches,
  scheduleVersions,
  scheduleAuditLog,
} from "../../../db/schema";
import { eq, inArray } from "drizzle-orm";
import {
  OrchestratedEventInput,
  ControlPlaneOptions,
  BatchExecutionReceipt,
  compareEventPrecedence,
  getEventUrgency,
} from "./control-plane.types";
import { EventCoalescer } from "./event-coalescer";
import { OperationalReplanningService } from "../operational-replanning/operational-replanning.service";
import { DynamicReplanningService } from "../dynamic-replanning/dynamic-replanning.service";

export class EventControlPlaneService {
  private coalescer = new EventCoalescer();
  private operationalService = new OperationalReplanningService();
  private dynamicReplanningService = new DynamicReplanningService();

  // In-process serialization queue to guarantee deterministic single-flight execution
  private queueLock: Promise<any> = Promise.resolve();

  /**
   * Main entry point: Ingests an event (or burst of events) through the control plane.
   */
  public async ingestEvents(
    rawEvents: OrchestratedEventInput[],
    options: ControlPlaneOptions
  ): Promise<BatchExecutionReceipt> {
    if (!rawEvents || rawEvents.length === 0) {
      throw new Error("ingestEvents requires at least one event");
    }

    // 1. Idempotency Check:
    // If a single event is requested and already completed, return its cached receipt immediately
    if (rawEvents.length === 1) {
      const [existing] = await db
        .select()
        .from(operationalEventLedger)
        .where(eq(operationalEventLedger.idempotencyKey, rawEvents[0]!.idempotencyKey))
        .limit(1);

      if (existing && existing.status === "COMPLETED" && existing.executionReceipt) {
        return existing.executionReceipt as unknown as BatchExecutionReceipt;
      }
    }

    // 2. Queue for serialized single-flight execution
    const runTask = async () => {
      return await this.executeSerializedBatch(rawEvents, options);
    };

    const resultPromise = this.queueLock.then(runTask, runTask);
    this.queueLock = resultPromise.catch(() => {});
    return await resultPromise;
  }

  /**
   * Serialized batch execution logic.
   */
  private async executeSerializedBatch(
    rawEvents: OrchestratedEventInput[],
    options: ControlPlaneOptions
  ): Promise<BatchExecutionReceipt> {
    const startTime = new Date();
    const refTime = options.referenceTime || new Date();
    const freezeHorizon = options.freezeHorizonSeconds ?? 900;
    const policy = options.policy || "HYBRID";
    const userId = options.userId;

    // Check existing idempotency across all events in batch
    const allKeys = rawEvents.map((e) => e.idempotencyKey);
    const existingRows = await db
      .select()
      .from(operationalEventLedger)
      .where(inArray(operationalEventLedger.idempotencyKey, allKeys));

    const existingByKey = new Map(existingRows.map((r) => [r.idempotencyKey, r]));

    // If all events in batch are already COMPLETED with same receipt, return existing receipt
    if (
      rawEvents.length > 0 &&
      rawEvents.every((e) => existingByKey.get(e.idempotencyKey)?.status === "COMPLETED")
    ) {
      const first = existingByKey.get(rawEvents[0]!.idempotencyKey);
      if (first?.executionReceipt) {
        return first.executionReceipt as unknown as BatchExecutionReceipt;
      }
    }

    // 1. Persist new events in ledger with status RECEIVED
    for (const evt of rawEvents) {
      if (!existingByKey.has(evt.idempotencyKey)) {
        await db
          .insert(operationalEventLedger)
          .values({
            idempotencyKey: evt.idempotencyKey,
            eventType: evt.eventType,
            urgency: evt.urgency || getEventUrgency(evt.eventType),
            payload: evt.payload,
            status: "RECEIVED",
          })
          .onConflictDoNothing();
      }
    }

    // 2. Coalescing & Subsumption
    const { activeEvents, supersededEvents } = this.coalescer.coalesceEvents(rawEvents);

    // Update superseded events in ledger
    for (const sup of supersededEvents) {
      await db
        .update(operationalEventLedger)
        .set({
          status: "SUPERSEDED",
          error: `Superseded by ${sup.supersededBy}: ${sup.reason}`,
          updatedAt: new Date(),
        })
        .where(eq(operationalEventLedger.idempotencyKey, sup.event.idempotencyKey));
    }

    // 3. Deterministic Precedence Ordering
    // Level 1: Outage -> Level 2: Orbital -> Level 3: Preemption -> Level 4: Opportunity
    activeEvents.sort(compareEventPrecedence);

    // 4. Batch Execution
    const verRes = await db.select().from(scheduleVersions).limit(1);
    const vBefore = verRes[0]?.version || 0;

    // Create operational_batches record
    const [batchRecord] = await db
      .insert(operationalBatches)
      .values({
        status: "PROCESSING",
        scheduleVersionBefore: vBefore,
        scheduleVersionAfter: vBefore,
        eventCount: activeEvents.length,
        eventIds: activeEvents.map((e) => e.idempotencyKey),
      })
      .returning();

    if (!batchRecord) {
      throw new Error("Failed to initialize operational batch record");
    }
    const batchId = batchRecord.id;

    // Update active events to PROCESSING
    await db
      .update(operationalEventLedger)
      .set({
        status: "PROCESSING",
        batchId,
        updatedAt: new Date(),
      })
      .where(inArray(operationalEventLedger.idempotencyKey, activeEvents.map((e) => e.idempotencyKey)));

    let totalDisplaced = 0;
    let totalRescued = 0;
    let totalUnrescuable = 0;
    let totalFrozenBlocked = 0;
    let batchStateChanged = false;
    const eventResults: BatchExecutionReceipt["eventResults"] = [];

    try {
      // Execute each event in deterministic precedence order
      for (const evt of activeEvents) {
        if (evt.eventType === "ORBITAL_UPDATE") {
          // Delegate to Phase 5.1 Dynamic Replanning Service
          const satelliteIds = evt.payload.satelliteIds || [];
          const repResult = await this.dynamicReplanningService.replan({
            scheduleVersion: vBefore,
            satelliteIds,
            strategy: "TARGETED",
            policy: policy as any,
            userId,
            referenceTime: refTime,
            skipVersionIncrement: true,
          });

          totalDisplaced += repResult.impact.invalidatedReservationIds.length;
          totalRescued += repResult.rescuedCount;
          totalUnrescuable += repResult.unrescuableCount;
          if (repResult.impact.invalidatedReservationIds.length > 0 || repResult.rescuedCount > 0) {
            batchStateChanged = true;
          }

          eventResults.push({
            idempotencyKey: evt.idempotencyKey,
            eventType: evt.eventType,
            displacedCount: repResult.impact.invalidatedReservationIds.length,
            rescuedCount: repResult.rescuedCount,
            unrescuableCount: repResult.unrescuableCount,
            frozenBlockedCount: 0,
            details: repResult.impact.details,
          });
        } else {
          // Delegate to Phase 5.2 Operational Replanning Service
          const opResult = await this.operationalService.handleOperationalEvent(
            {
              type: evt.eventType,
              ...evt.payload,
            } as any,
            {
              userId,
              referenceTime: refTime,
              freezeHorizonSeconds: freezeHorizon,
              policy: policy as any,
              skipVersionIncrement: true,
            }
          );

          totalDisplaced += opResult.displacedReservationsCount;
          totalRescued += opResult.rescuedCount;
          totalUnrescuable += opResult.unrescuableCount;
          totalFrozenBlocked += opResult.frozenBlockedCount;
          if (!opResult.isNoOp) {
            batchStateChanged = true;
          }

          eventResults.push({
            idempotencyKey: evt.idempotencyKey,
            eventType: evt.eventType,
            displacedCount: opResult.displacedReservationsCount,
            rescuedCount: opResult.rescuedCount,
            unrescuableCount: opResult.unrescuableCount,
            frozenBlockedCount: opResult.frozenBlockedCount,
            details: opResult.details,
          });
        }
      }

      // Check if state changed
      const anyStateChange = batchStateChanged || totalDisplaced > 0 || totalRescued > 0;
      const vAfter = anyStateChange ? vBefore + 1 : vBefore;

      if (anyStateChange) {
        await db
          .update(scheduleVersions)
          .set({ version: vAfter, updatedAt: new Date() })
          .where(eq(scheduleVersions.version, vBefore));
      }

      const completedAt = new Date();
      const receipt: BatchExecutionReceipt = {
        batchId,
        status: "COMPLETED",
        scheduleVersionBefore: vBefore,
        scheduleVersionAfter: vAfter,
        isNoOp: !anyStateChange,
        eventsProcessedCount: activeEvents.length,
        supersededCount: supersededEvents.length,
        totalDisplacedCount: totalDisplaced,
        totalRescuedCount: totalRescued,
        totalUnrescuableCount: totalUnrescuable,
        frozenBlockedCount: totalFrozenBlocked,
        eventResults,
        createdAt: startTime,
        completedAt,
      };

      // Correlated Audit Entry
      await db.insert(scheduleAuditLog).values({
        userId,
        action: "OPERATIONAL_BATCH_EXECUTION",
        entityType: "BATCH",
        entityId: batchId,
        reason: `ORCHESTRATED_EVENT_BATCH (${activeEvents.map((e) => e.eventType).join(", ")})`,
        afterState: {
          scheduleVersionBefore: vBefore,
          scheduleVersionAfter: vAfter,
          eventsProcessed: activeEvents.map((e) => e.idempotencyKey),
          superseded: supersededEvents.map((s) => s.event.idempotencyKey),
        },
      });

      // Update operational_batches record
      await db
        .update(operationalBatches)
        .set({
          status: "COMPLETED",
          scheduleVersionAfter: vAfter,
          summary: receipt as any,
          completedAt,
        })
        .where(eq(operationalBatches.id, batchId));

      // Update all ledger items to COMPLETED with receipt
      for (const evt of activeEvents) {
        await db
          .update(operationalEventLedger)
          .set({
            status: "COMPLETED",
            executionReceipt: receipt as any,
            updatedAt: completedAt,
          })
          .where(eq(operationalEventLedger.idempotencyKey, evt.idempotencyKey));
      }

      return receipt;
    } catch (err: any) {
      // Error handling & recovery state: Mark batch and ledger items as FAILED, version N -> N
      await db
        .update(operationalBatches)
        .set({
          status: "FAILED",
          summary: { error: err.message },
          completedAt: new Date(),
        })
        .where(eq(operationalBatches.id, batchId));

      await db
        .update(operationalEventLedger)
        .set({
          status: "FAILED",
          error: err.message,
          updatedAt: new Date(),
        })
        .where(inArray(operationalEventLedger.idempotencyKey, activeEvents.map((e) => e.idempotencyKey)));

      throw err;
    }
  }

  /**
   * Recovers / retries an interrupted or failed batch.
   */
  public async retryBatch(batchId: string, options: ControlPlaneOptions): Promise<BatchExecutionReceipt> {
    const [batch] = await db
      .select()
      .from(operationalBatches)
      .where(eq(operationalBatches.id, batchId))
      .limit(1);

    if (!batch) {
      throw new Error(`Batch ${batchId} not found`);
    }

    if (batch.status === "COMPLETED" && batch.summary) {
      // Idempotent retry: already completed, return existing receipt
      return batch.summary as unknown as BatchExecutionReceipt;
    }

    // Retrieve original events
    const eventKeys = batch.eventIds as string[];
    const ledgerItems = await db
      .select()
      .from(operationalEventLedger)
      .where(inArray(operationalEventLedger.idempotencyKey, eventKeys));

    const eventsToRetry: OrchestratedEventInput[] = ledgerItems.map((item) => ({
      idempotencyKey: item.idempotencyKey,
      eventType: item.eventType as any,
      payload: item.payload as any,
    }));

    return await this.executeSerializedBatch(eventsToRetry, options);
  }
}
