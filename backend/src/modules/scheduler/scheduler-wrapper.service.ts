import { db, txContext } from "../../db/client";
import { scheduleVersions, scheduleProposals, reservations, missionTasks, scheduleAuditLog } from "../../db/schema";
import { eq, and, inArray, sql } from "drizzle-orm";
import { MetaScheduler } from "../meta-scheduler/meta-scheduler";
import { CandidateService } from "./candidate-service";
import { UrgencyScheduler } from "./urgency-scheduler";
import { HybridScoringScheduler } from "./hybrid-scoring-scheduler";
import { DEFAULT_HYBRID_WEIGHTS } from "./scoring";

class PreviewRollback extends Error {
  constructor(public payload: any) {
    super("PREVIEW_ROLLBACK");
    this.name = "PreviewRollback";
  }
}

export class SchedulerWrapperService {
  private candidateService = new CandidateService();

  async preview(expectedVersion: number, policy?: string) {
    // 1. Check schedule version
    const versionResult = await db.select().from(scheduleVersions).limit(1);
    const currentVersion = versionResult[0]?.version || 0;
    if (currentVersion !== expectedVersion) {
      const err: any = new Error("Schedule version conflict");
      err.name = "VersionConflictError";
      err.code = "SCHEDULE_VERSION_CONFLICT";
      throw err;
    }

    // 2. Read locked reservations
    const lockedRes = await db.select().from(reservations).where(eq(reservations.locked, true));

    let previewPayload: any;

    try {
      await db.transaction(async (tx) => {
        await txContext.run(tx, async () => {
          // Clear only replaceable, unexecuted AUTOMATED reservations to allow rescheduling
          // Invariant: MANUAL, LOCKED, and active/dispatched executions (EXECUTION_READY, IN_PROGRESS, COMPLETED) are preserved
          const unlockedRes = await tx.delete(reservations)
            .where(
              and(
                eq(reservations.source, "AUTOMATED"),
                eq(reservations.locked, false),
                eq(reservations.executionState, "SCHEDULED")
              )
            )
            .returning();
          
          if (unlockedRes.length > 0) {
            const taskIds = unlockedRes.map(r => r.missionTaskId);
            await tx.update(missionTasks)
              .set({ status: "PENDING" })
              .where(inArray(missionTasks.id, taskIds));
          }

          let scheduler: any;
          if (policy === "URGENCY") {
            scheduler = new UrgencyScheduler(this.candidateService);
          } else if (policy === "HYBRID") {
            scheduler = new HybridScoringScheduler(this.candidateService, new Date(), DEFAULT_HYBRID_WEIGHTS, "HYBRID");
          } else if (policy === "PRIORITY") {
            scheduler = new HybridScoringScheduler(this.candidateService, new Date(), DEFAULT_HYBRID_WEIGHTS, "PRIORITY");
          } else if (policy === "FCFS") {
            scheduler = new HybridScoringScheduler(this.candidateService, new Date(), DEFAULT_HYBRID_WEIGHTS, "FCFS");
          } else if (policy === "META") {
            scheduler = new MetaScheduler(this.candidateService, "PRODUCTION");
          } else {
            scheduler = new HybridScoringScheduler(this.candidateService, new Date(), DEFAULT_HYBRID_WEIGHTS, "HYBRID");
          }
          const result = await scheduler.schedulePendingTasks();

          // Capture the exact reservations that were proposed
          const scheduledIds = result.results
            .filter((r: any) => r.status === "SCHEDULED" && r.reservationId)
            .map((r: any) => r.reservationId as string);

          let proposedReservations: any[] = [];
          if (scheduledIds.length > 0) {
            proposedReservations = await tx.select().from(reservations).where(inArray(reservations.id, scheduledIds));
          }

          // Capture the missionTasks updates as well so we can apply them on commit
          throw new PreviewRollback({
            result,
            proposedReservations
          });
        });
      });
    } catch (e: any) {
      if (e.name === "PreviewRollback" || e.message === "PREVIEW_ROLLBACK") {
        previewPayload = e.payload;
      } else {
        throw e;
      }
    }

    // 4. Construct response
    return {
      policy: policy || "HYBRID",
      scheduleVersion: currentVersion,
      lockedReservations: lockedRes,
      proposedReservations: previewPayload.proposedReservations,
      changes: previewPayload.result.results.filter((r: any) => r.status === "SCHEDULED"),
      unchanged: [], // for now
      unscheduled: previewPayload.result.results.filter((r: any) => r.status === "UNSCHEDULED"),
      metrics: previewPayload.result.metrics,
      scoreBreakdowns: previewPayload.result.scoreBreakdowns || [],
    };
  }

  async commit(proposedReservations: any[], expectedVersion: number, userId: string, policy: string = "HYBRID") {
    return await db.transaction(async (tx) => {
      // 1. Lock schedule version
      const versionResult = await tx.select().from(scheduleVersions).for("update").limit(1);
      const currentVersion = versionResult[0]?.version || 0;

      if (currentVersion !== expectedVersion) {
        const err: any = new Error("Schedule version conflict");
        err.name = "VersionConflictError";
        err.code = "SCHEDULE_VERSION_CONFLICT";
        throw err;
      }

      // We delete ONLY unexecuted, unlocked AUTOMATED reservations so the new proposal can take their place
      // Invariant: MANUAL, LOCKED, and active/dispatched executions (EXECUTION_READY, IN_PROGRESS, COMPLETED) are preserved
      const unlockedRes = await tx.delete(reservations)
        .where(
          and(
            eq(reservations.source, "AUTOMATED"),
            eq(reservations.locked, false),
            eq(reservations.executionState, "SCHEDULED")
          )
        )
        .returning();
      
      if (unlockedRes.length > 0) {
        const taskIds = unlockedRes.map(r => r.missionTaskId);
        await tx.update(missionTasks)
          .set({ status: "PENDING" })
          .where(inArray(missionTasks.id, taskIds));
      }

      const auditRecords: any[] = [];
      for (const resv of proposedReservations) {
        await tx.insert(reservations).values({
          id: resv.id,
          missionTaskId: resv.missionTaskId,
          contactWindowId: resv.contactWindowId,
          groundStationId: resv.groundStationId,
          satelliteId: resv.satelliteId,
          windowAos: new Date(resv.windowAos),
          windowLos: new Date(resv.windowLos),
          taskDurationSeconds: resv.taskDurationSeconds,
          allocatedStart: new Date(resv.allocatedStart),
          allocatedEnd: new Date(resv.allocatedEnd),
          source: "AUTOMATED",
          status: "PENDING",
          locked: false
        });

        await tx.update(missionTasks).set({ status: "SCHEDULED" }).where(eq(missionTasks.id, resv.missionTaskId));

        auditRecords.push({
          userId,
          entityType: "RESERVATION",
          entityId: resv.id,
          action: "CREATE_RESERVATION",
          afterState: { ...resv, policy },
          reason: `Automated schedule commit (${policy})`
        });
      }

      auditRecords.push({
        userId,
        entityType: "SCHEDULE",
        entityId: `v${currentVersion}`,
        action: "COMMIT_SCHEDULE",
        afterState: { policy, committedCount: proposedReservations.length, newVersion: currentVersion + 1 },
        reason: `Automated schedule commit with policy: ${policy}`
      });

      if (auditRecords.length > 0) {
        await tx.insert(scheduleAuditLog).values(auditRecords);
      }

      // Increment version
      await tx.update(scheduleVersions).set({ version: sql`${scheduleVersions.version} + 1` });

      return { success: true, committed: proposedReservations.length, policy, newVersion: currentVersion + 1 };
    });
  }
}
