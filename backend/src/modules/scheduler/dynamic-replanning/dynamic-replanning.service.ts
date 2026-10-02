import { db, txContext } from "../../../db/client";
import {
  reservations,
  missionTasks,
  scheduleVersions,
  scheduleAuditLog,
} from "../../../db/schema";
import { eq, inArray, sql, and } from "drizzle-orm";
import { ScheduleInvalidationService, InvalidationAnalysisResult } from "./schedule-invalidation.service";
import { CandidateService } from "../candidate-service";
import { HybridScoringScheduler } from "../hybrid-scoring-scheduler";
import { DEFAULT_HYBRID_WEIGHTS } from "../scoring";
import { UrgencyScheduler } from "../urgency-scheduler";

export interface ReplanningRequest {
  scheduleVersion: number;
  satelliteIds: string[];
  strategy: "TARGETED" | "FULL";
  policy?: "HYBRID" | "PRIORITY" | "FCFS" | "URGENCY" | undefined;
  userId: string;
  referenceTime?: Date | undefined;
  skipVersionIncrement?: boolean | undefined;
}

export interface ReplanningResult {
  strategy: "TARGETED" | "FULL";
  policy: string;
  previousVersion: number;
  newVersion: number;
  impact: InvalidationAnalysisResult;
  rescuedCount: number;
  unrescuableCount: number;
  executionTimeMs: number;
  rescuedReservationIds: string[];
  unrescuableTaskIds: string[];
}

export class DynamicReplanningService {
  private invalidationService = new ScheduleInvalidationService();
  private candidateService = new CandidateService();

  /**
   * Performs impact analysis and executes targeted or full dynamic replanning
   * under optimistic concurrency protection.
   */
  public async replan(request: ReplanningRequest): Promise<ReplanningResult> {
    const startTime = Date.now();
    const policy = request.policy || "HYBRID";
    const refTime = request.referenceTime || new Date();

    // 1. Concurrency Check
    const versionRes = await db.select().from(scheduleVersions).limit(1);
    const currentVersion = versionRes[0]?.version || 0;
    if (currentVersion !== request.scheduleVersion) {
      const err: any = new Error("Schedule version conflict during replanning");
      err.name = "VersionConflictError";
      err.code = "SCHEDULE_VERSION_CONFLICT";
      throw err;
    }

    // 2. Impact Analysis
    const impact = await this.invalidationService.analyzeImpact(
      request.satelliteIds,
      refTime
    );

    // If nothing is invalidated and strategy is TARGETED, schedule is intact
    if (impact.invalidatedReservationIds.length === 0 && request.strategy === "TARGETED") {
      return {
        strategy: "TARGETED",
        policy,
        previousVersion: currentVersion,
        newVersion: currentVersion,
        impact,
        rescuedCount: 0,
        unrescuableCount: 0,
        executionTimeMs: Date.now() - startTime,
        rescuedReservationIds: [],
        unrescuableTaskIds: [],
      };
    }

    let rescuedCount = 0;
    let unrescuableCount = 0;
    const rescuedReservationIds: string[] = [];
    const unrescuableTaskIds: string[] = [];

    // 3. Transactional Execution
    await db.transaction(async (tx) => {
      await txContext.run(tx, async () => {
        if (request.strategy === "TARGETED") {
          // --- TARGETED RESCHEDULING ---
          // A. Cancel only invalidated reservations
          if (impact.invalidatedReservationIds.length > 0) {
            await tx
              .update(reservations)
              .set({
                status: "CANCELLED",
                updatedAt: new Date(),
              })
              .where(inArray(reservations.id, impact.invalidatedReservationIds));

            // B. Reset affected tasks to PENDING
            await tx
              .update(missionTasks)
              .set({
                status: "PENDING",
                updatedAt: new Date(),
              })
              .where(inArray(missionTasks.id, impact.affectedTaskIds));

            // C. Audit log for invalidations
            for (const rId of impact.invalidatedReservationIds) {
              await tx.insert(scheduleAuditLog).values({
                userId: request.userId,
                action: "CANCEL_RESERVATION",
                entityType: "RESERVATION",
                entityId: rId,
                reason: "ORBITAL_UPDATE_DISPLACEMENT",
              });
            }
          }

          // D. Reschedule ONLY the affected tasks
          if (impact.affectedTaskIds.length > 0) {
            let scheduler: any;
            if (policy === "URGENCY") {
              scheduler = new UrgencyScheduler(this.candidateService);
            } else {
              scheduler = new HybridScoringScheduler(
                this.candidateService,
                refTime,
                DEFAULT_HYBRID_WEIGHTS,
                policy as any
              );
            }

            const scheduleRes = await scheduler.schedulePendingTasks(impact.affectedTaskIds);
            rescuedCount = scheduleRes.scheduled;
            unrescuableCount = scheduleRes.unscheduled;

            for (const r of scheduleRes.results) {
              if (r.status === "SCHEDULED" && r.reservationId) {
                rescuedReservationIds.push(r.reservationId);
                await tx.insert(scheduleAuditLog).values({
                  userId: request.userId,
                  action: "CREATE_RESERVATION",
                  entityType: "RESERVATION",
                  entityId: r.reservationId,
                  reason: `TARGETED_REPLANNING_RESCUE_${policy}`,
                });
              } else if (r.status === "UNSCHEDULED") {
                unrescuableTaskIds.push(r.taskId);
              }
            }
          }
        } else {
          // --- FULL REGENERATION BASELINE ---
          // A. Cancel ALL active non-locked reservations
          const activeResvs = await tx
            .select()
            .from(reservations)
            .where(
              and(
                inArray(reservations.status, ["PENDING", "CONFIRMED"]),
                eq(reservations.locked, false)
              )
            );

          const activeIds = activeResvs.map((r) => r.id);
          const taskIds = activeResvs.map((r) => r.missionTaskId);

          if (activeIds.length > 0) {
            await tx
              .update(reservations)
              .set({
                status: "CANCELLED",
                updatedAt: new Date(),
              })
              .where(inArray(reservations.id, activeIds));

            await tx
              .update(missionTasks)
              .set({
                status: "PENDING",
                updatedAt: new Date(),
              })
              .where(inArray(missionTasks.id, taskIds));
          }

          // B. Reschedule ALL pending tasks
          let scheduler: any;
          if (policy === "URGENCY") {
            scheduler = new UrgencyScheduler(this.candidateService);
          } else {
            scheduler = new HybridScoringScheduler(
              this.candidateService,
              refTime,
              DEFAULT_HYBRID_WEIGHTS,
              policy as any
            );
          }

          const scheduleRes = await scheduler.schedulePendingTasks();
          rescuedCount = scheduleRes.scheduled;
          unrescuableCount = scheduleRes.unscheduled;

          for (const r of scheduleRes.results) {
            if (r.status === "SCHEDULED" && r.reservationId) {
              rescuedReservationIds.push(r.reservationId);
            } else if (r.status === "UNSCHEDULED") {
              unrescuableTaskIds.push(r.taskId);
            }
          }
        }

        // Increment schedule version (unless orchestrated by a control plane batch)
        if (!request.skipVersionIncrement) {
          await tx
            .update(scheduleVersions)
            .set({
              version: currentVersion + 1,
              updatedAt: new Date(),
            })
            .where(eq(scheduleVersions.version, currentVersion));

          // Audit log for schedule version advancement
          await tx.insert(scheduleAuditLog).values({
            userId: request.userId,
            action: "COMMIT_SCHEDULE",
            entityType: "SCHEDULE",
            entityId: String(currentVersion + 1),
            reason: `DYNAMIC_REPLANNING_${request.strategy}_${policy}`,
          });
        }
      });
    });

    const executionTimeMs = Date.now() - startTime;

    return {
      strategy: request.strategy,
      policy,
      previousVersion: currentVersion,
      newVersion: request.skipVersionIncrement ? currentVersion : currentVersion + 1,
      impact,
      rescuedCount,
      unrescuableCount,
      executionTimeMs,
      rescuedReservationIds,
      unrescuableTaskIds,
    };
  }
}
