import { TrialSnapshot } from "../impact-types";
import { calculateFeatures } from "../../meta-scheduler/workload-analyzer";
import { selectPolicy, ProductionPolicy, PolicyDecision } from "../../meta-scheduler/policy-selector";
import { Task, ContactWindow } from "../../meta-scheduler/types";
import { LabDbManager } from "./targeted-rescheduler";
import { FcfsScheduler } from "../../scheduler/fcfs-scheduler";
import { PriorityScheduler } from "../../scheduler/priority-scheduler";
import { HybridScheduler } from "../../scheduler/hybrid-scheduler";
import { CandidateService } from "../../scheduler/candidate-service";
import { db } from "../../../db/client";
import { missionTasks, reservations } from "../../../db/schema";

export interface PolicyEvaluationResult {
  p0: PolicyDecision;
  p1: PolicyDecision;
  policyChanged: boolean;
  policyBlindPws: number; // The PWS if we blindly reuse P0 on W1
  reevaluatedPws: number; // The PWS if we correctly use P1 on W1
  regret: number;         // reevaluatedPws - policyBlindPws
}

export class PolicyEvaluator {
  public async evaluateH4(snapshot: TrialSnapshot): Promise<PolicyEvaluationResult> {
    const referenceTime = new Date(snapshot.workloadMetadata.referenceTime || snapshot.workload[0]?.created_at || new Date());
    
    // Convert to analyzer-compatible types
    const metaTasks: Task[] = snapshot.workload.map(t => ({
      id: t.id,
      priority: t.priority,
      duration_ms: (t as any).duration_ms || t.durationSeconds * 1000,
      deadline: t.deadline
    }));

    const metaW0: ContactWindow[] = snapshot.w0.map(w => ({
      id: w.id,
      ground_station_id: w.ground_station_id,
      aos: w.aos,
      los: w.los
    }));

    const metaW1: ContactWindow[] = snapshot.w1_frozen.map(w => ({
      id: w.id,
      ground_station_id: w.ground_station_id,
      aos: w.aos,
      los: w.los
    }));

    // 1. Calculate features and policies
    const f0 = calculateFeatures(metaTasks, metaW0, [], referenceTime);
    const f1 = calculateFeatures(metaTasks, metaW1, [], referenceTime);

    const p0 = selectPolicy(f0);
    const p1 = selectPolicy(f1);
    
    const policyChanged = p0.policy !== p1.policy;

    let policyBlindPws = 0;
    let reevaluatedPws = 0;

    // 2. If policy changed, we must measure the regret. 
    // If it didn't change, blind and reevaluated are identical by definition.
    if (policyChanged) {
      // Measure Policy-Blind (P0 on W1)
      policyBlindPws = await this.runSpecificPolicy(snapshot, p0.policy, referenceTime);
      
      // Measure Re-evaluated (P1 on W1)
      reevaluatedPws = await this.runSpecificPolicy(snapshot, p1.policy, referenceTime);
    } else {
      // We still need to calculate the PWS for completeness, using the consistent policy.
      reevaluatedPws = await this.runSpecificPolicy(snapshot, p1.policy, referenceTime);
      policyBlindPws = reevaluatedPws;
    }

    return {
      p0,
      p1,
      policyChanged,
      policyBlindPws,
      reevaluatedPws,
      regret: reevaluatedPws - policyBlindPws
    };
  }

  private async runSpecificPolicy(snapshot: TrialSnapshot, policy: ProductionPolicy, referenceTime: Date): Promise<number> {
    const allTaskIds = new Set(snapshot.workload.map(t => t.id));

    // Seed DB cleanly with ALL tasks pending, NO existing reservations, and W1 frozen
    await LabDbManager.seedEnvironment(snapshot, [], allTaskIds);

    const candidateService = new CandidateService();
    let scheduler;

    switch (policy) {
      case 'FCFS':
        scheduler = new FcfsScheduler(candidateService);
        break;
      case 'PRIORITY':
        scheduler = new PriorityScheduler(candidateService);
        break;
      case 'HYBRID_SLACK':
        scheduler = new HybridScheduler(candidateService, "SLACK", referenceTime);
        break;
      default:
        scheduler = new FcfsScheduler(candidateService);
    }

    if (scheduler.schedulePendingTasks) {
      await scheduler.schedulePendingTasks();
    } else {
      await (scheduler as any).schedule();
    }

    const finalReservations = await db.select().from(reservations);
    const finalTasks = await db.select().from(missionTasks);

    const scheduledTaskIds = new Set(finalReservations.map(r => r.missionTaskId));
    let pws = 0;
    for (const t of finalTasks) {
      if (scheduledTaskIds.has(t.id)) {
        pws += t.priority;
      }
    }

    return pws;
  }
}
