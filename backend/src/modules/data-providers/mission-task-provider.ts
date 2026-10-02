import { missionTasks } from "../../db/schema";
import type { InferInsertModel } from "drizzle-orm";

export type NewMissionTask = InferInsertModel<typeof missionTasks>;

export interface MissionTaskProvider {
  getMissionTasks(satelliteIds: string[], referenceTime: Date): Promise<NewMissionTask[]>;
}
