import { db } from "../../db/client";
import { missionTasks, reservations } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { CandidateService } from "./candidate-service";
import { SchedulerResult, TaskOutcome } from "./types";
import { HybridStrategy, SchedulerPolicy } from "./hybrid-policy";

interface TaskScore {
  task: any; 
  feasible: boolean;
  reason?: "NO_FEASIBLE_WINDOW" | "DEADLINE_EXCEEDED";
  slackSeconds: number;
  urgencyRatio: number;
}

export class HybridScheduler implements SchedulerPolicy {
  constructor(
    private candidateService: CandidateService,
    private strategy: HybridStrategy,
    private experimentReferenceTime: Date
  ) {}

  async schedulePendingTasks(): Promise<SchedulerResult> {
    const pendingTasks = await db.select()
      .from(missionTasks)
      .where(eq(missionTasks.status, "PENDING"));

    const scoredTasks: TaskScore[] = [];

    // Step 2 & 3 & 4 & 5: Batch candidate evaluation & scoring
    for (const task of pendingTasks) {
      const candidateWindows = await this.candidateService.findCandidateWindows(task.satelliteId, task.deadline);
      
      let feasible = false;
      let earliestFeasibleEnd: Date | null = null;
      let reason: "NO_FEASIBLE_WINDOW" | "DEADLINE_EXCEEDED" | undefined = undefined;

      if (candidateWindows.length === 0) {
        const hasAny = await this.candidateService.hasAnyWindow(task.satelliteId);
        reason = hasAny ? "DEADLINE_EXCEEDED" : "NO_FEASIBLE_WINDOW";
      } else {
        reason = "NO_FEASIBLE_WINDOW"; // default until found
        for (const window of candidateWindows) {
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

          if (intervalResult.status === "SUCCESS") {
            feasible = true;
            earliestFeasibleEnd = intervalResult.end;
            reason = undefined;
            break; 
          } else {
            if (intervalResult.reason === "DEADLINE_EXCEEDED") {
              reason = "DEADLINE_EXCEEDED";
            }
          }
        }
      }

      // Calculate Slack (deadline - earliestFeasibleEnd)
      const slackSeconds = feasible && earliestFeasibleEnd
        ? (task.deadline.getTime() - earliestFeasibleEnd.getTime()) / 1000
        : Infinity;

      // Calculate Urgency Ratio: duration / (deadline - referenceTime)
      const remainingTimeSeconds = (task.deadline.getTime() - this.experimentReferenceTime.getTime()) / 1000;
      // If remaining time is <= 0, ratio is essentially Infinity (infinitely urgent)
      const urgencyRatio = remainingTimeSeconds > 0
        ? task.durationSeconds / remainingTimeSeconds
        : Infinity;

      scoredTasks.push({
        task,
        feasible,
        ...(reason && { reason }),
        slackSeconds,
        urgencyRatio
      });
    }

    // Step 6: Sort
    scoredTasks.sort((a, b) => {
      // 1. Feasible first
      if (a.feasible && !b.feasible) return -1;
      if (!a.feasible && b.feasible) return 1;

      // 2. Primary strategy
      if (this.strategy === "SLACK") {
        if (a.slackSeconds !== b.slackSeconds) {
          return a.slackSeconds - b.slackSeconds; // ASC
        }
      } else if (this.strategy === "URGENCY_RATIO") {
        if (a.urgencyRatio !== b.urgencyRatio) {
          return b.urgencyRatio - a.urgencyRatio; // DESC
        }
      }

      // 3. Priority DESC
      if (a.task.priority !== b.task.priority) {
        return b.task.priority - a.task.priority;
      }

      // 4. Created_at ASC
      const timeDiff = a.task.createdAt.getTime() - b.task.createdAt.getTime();
      if (timeDiff !== 0) return timeDiff;

      // 5. ID ASC
      return a.task.id.localeCompare(b.task.id);
    });

    let scheduled = 0;
    let unscheduled = 0;
    const results: TaskOutcome[] = [];

    // Step 7, 8, 9: Sequential processing & actual candidate revalidation
    for (const scored of scoredTasks) {
      if (!scored.feasible) {
        unscheduled++;
        results.push({ taskId: scored.task.id, status: "UNSCHEDULED", reason: scored.reason! });
        continue;
      }

      const task = scored.task;
      let taskScheduled = false;
      let actualReason = "NO_FEASIBLE_WINDOW";

      const candidateWindows = await this.candidateService.findCandidateWindows(task.satelliteId, task.deadline);
      
      if (candidateWindows.length === 0) {
        const hasAny = await this.candidateService.hasAnyWindow(task.satelliteId);
        actualReason = hasAny ? "DEADLINE_EXCEEDED" : "NO_FEASIBLE_WINDOW";
        unscheduled++;
        results.push({ taskId: task.id, status: "UNSCHEDULED", reason: actualReason });
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
              actualReason = "DEADLINE_EXCEEDED";
            }
            break; // Move to next window
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
        } // Retry loop
      } // Window loop

      if (!taskScheduled) {
        unscheduled++;
        results.push({ taskId: task.id, status: "UNSCHEDULED", reason: actualReason });
      }
    }

    return { scheduled, unscheduled, results };
  }
}
