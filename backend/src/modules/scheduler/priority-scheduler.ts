import { db } from "../../db/client";
import { missionTasks, reservations } from "../../db/schema";
import { eq, asc, desc, and } from "drizzle-orm";
import { CandidateService } from "./candidate-service";
import { SchedulerResult, TaskOutcome } from "./types";
import { SchedulerPolicy } from "./hybrid-policy";

export class PriorityScheduler implements SchedulerPolicy {
  constructor(private candidateService: CandidateService) {}

  async schedulePendingTasks(): Promise<SchedulerResult> {
    const tasks = await db.select()
      .from(missionTasks)
      .where(eq(missionTasks.status, "PENDING"))
      .orderBy(
        desc(missionTasks.priority), 
        asc(missionTasks.createdAt), 
        asc(missionTasks.id)
      );

    let scheduled = 0;
    let unscheduled = 0;
    const results: TaskOutcome[] = [];

    for (const task of tasks) {
      let taskScheduled = false;

      let taskReason = "NO_FEASIBLE_WINDOW";

      const candidateWindows = await this.candidateService.findCandidateWindows(task.satelliteId, task.deadline);
      
      if (candidateWindows.length === 0) {
        const hasAny = await this.candidateService.hasAnyWindow(task.satelliteId);
        if (hasAny) {
          taskReason = "DEADLINE_EXCEEDED";
        }
        unscheduled++;
        results.push({ taskId: task.id, status: "UNSCHEDULED", reason: taskReason });
        continue;
      }

      windowLoop:
      for (const window of candidateWindows) {
        let retries = 0;
        const MAX_RETRIES = 3;

        while (retries < MAX_RETRIES) {
          const activeRes = await this.candidateService.getRelevantActiveReservations(
            window.groundStationId,
            window.aos,
            window.los
          );

          const intervalResult = this.candidateService.findEarliestFeasibleInterval(
            window.aos,
            window.los,
            task.durationSeconds,
            task.deadline,
            activeRes
          );

          if (intervalResult.status === "FAILED") {
            if (intervalResult.reason === "DEADLINE_EXCEEDED") {
              taskReason = "DEADLINE_EXCEEDED";
            }
            break; // No gap in this window, move to next candidate window
          }
          
          const interval = intervalResult;
          
          try {
            const reservationId = await db.transaction(async (tx) => {
              const updateResult = await tx.update(missionTasks)
                .set({ status: "SCHEDULED" })
                .where(and(eq(missionTasks.id, task.id), eq(missionTasks.status, "PENDING")))
                .returning();
              
              if (updateResult.length === 0) {
                throw new Error("TASK_ALREADY_HANDLED");
              }

              const resInsert = await tx.insert(reservations).values({
                missionTaskId: task.id,
                contactWindowId: window.id,
                groundStationId: window.groundStationId,
                satelliteId: task.satelliteId,
                windowAos: window.aos,
                windowLos: window.los,
                taskDurationSeconds: task.durationSeconds,
                allocatedStart: interval.start,
                allocatedEnd: interval.end,
                status: "PENDING"
              }).returning();

              return resInsert[0]!.id;
            });

            taskScheduled = true;
            scheduled++;
            results.push({ taskId: task.id, status: "SCHEDULED", reservationId });
            break windowLoop;

          } catch (error: any) {
            if (error.message === "TASK_ALREADY_HANDLED") {
              taskScheduled = true; 
              break windowLoop;
            }
            
            if (error.message.includes("exclude_overlapping_reservations_active") || error.message.includes("one_active_reservation_per_task")) {
              retries++;
              continue; 
            }

            throw error; 
          }
        } 
      } 

      if (!taskScheduled) {
        unscheduled++;
        results.push({ taskId: task.id, status: "UNSCHEDULED", reason: taskReason });
      }
    }

    return { scheduled, unscheduled, results };
  }
}
