import { db, txContext } from "../../db/client";
import { scheduleVersions, scheduleProposals, reservations, missionTasks, scheduleAuditLog } from "../../db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { MetaScheduler } from "../meta-scheduler/meta-scheduler";
import { CandidateService } from "./candidate-service";

class PreviewRollback extends Error {
  constructor(public payload: any) {
    super("PREVIEW_ROLLBACK");
    this.name = "PreviewRollback";
  }
}

export class SchedulerWrapperService {
  private candidateService = new CandidateService();

  async preview(expectedVersion: number) {
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
          // Clear all AUTOMATED reservations to allow rescheduling
          const unlockedRes = await tx.delete(reservations)
            .where(eq(reservations.source, "AUTOMATED"))
            .returning();
          
          if (unlockedRes.length > 0) {
            const taskIds = unlockedRes.map(r => r.missionTaskId);
            await tx.update(missionTasks)
              .set({ status: "PENDING" })
              .where(inArray(missionTasks.id, taskIds));
          }

          const metaScheduler = new MetaScheduler(this.candidateService, "PRODUCTION");
          const result = await metaScheduler.schedulePendingTasks();

          // Capture the exact reservations that were proposed
          const scheduledIds = result.results
            .filter(r => r.status === "SCHEDULED" && r.reservationId)
            .map(r => r.reservationId as string);

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
      console.error("Preview caught error:", e);
      if (e.name === "PreviewRollback" || e.message === "PREVIEW_ROLLBACK") {
        previewPayload = e.payload;
      } else {
        throw e;
      }
    }

    // 4. Construct response
    return {
      scheduleVersion: currentVersion,
      lockedReservations: lockedRes,
      proposedReservations: previewPayload.proposedReservations,
      changes: previewPayload.result.results.filter((r: any) => r.status === "SCHEDULED"),
      unchanged: [], // for now
      unscheduled: previewPayload.result.results.filter((r: any) => r.status === "UNSCHEDULED")
    };
  }

  async commit(proposedReservations: any[], expectedVersion: number, userId: string) {
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

      // We need to delete ALL existing AUTOMATED reservations so the new proposal can take their place
      const unlockedRes = await tx.delete(reservations)
        .where(eq(reservations.source, "AUTOMATED"))
        .returning();
      
      if (unlockedRes.length > 0) {
        const taskIds = unlockedRes.map(r => r.missionTaskId);
        await tx.update(missionTasks)
          .set({ status: "PENDING" })
          .where(inArray(missionTasks.id, taskIds));
      }

      const auditRecords: any[] = [];
      for (const resv of proposedReservations) {
        // Strip out the old UUID and createdAt so they get generated fresh, OR keep them?
        // Let's keep the same UUIDs so we match the proposal.
        
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
          afterState: resv,
          reason: "Automated schedule commit"
        });
      }

      if (auditRecords.length > 0) {
        await tx.insert(scheduleAuditLog).values(auditRecords);
      }

      // Increment version
      await tx.update(scheduleVersions).set({ version: sql`${scheduleVersions.version} + 1` });

      return { success: true, committed: proposedReservations.length };
    });
  }
}
