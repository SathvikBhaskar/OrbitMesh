import { SchedulerResult } from "./types";

export interface SchedulerPolicy {
  schedulePendingTasks(): Promise<SchedulerResult>;
}

export type HybridStrategy = "SLACK" | "URGENCY_RATIO";
