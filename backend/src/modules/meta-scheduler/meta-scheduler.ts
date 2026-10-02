import { SchedulerPolicy } from '../scheduler/hybrid-policy';
import { SchedulerResult } from '../scheduler/types';
import { CandidateService } from '../scheduler/candidate-service';
import { FcfsScheduler } from '../scheduler/fcfs-scheduler';
import { PriorityScheduler } from '../scheduler/priority-scheduler';
import { HybridScheduler } from '../scheduler/hybrid-scheduler';
import { calculateFeatures } from './workload-analyzer';
import { selectPolicy, PolicyDecision } from './policy-selector';
import { db } from '../../db/client';
import { missionTasks, contactWindows, reservations, schedulerRuns } from '../../db/schema';
import { sql } from 'drizzle-orm';
import { Task, ContactWindow, Reservation, WorkloadFeatures } from './types';
import { logger } from '../../config/logger';
import { schedulerRunsTotal, schedulerDurationMs } from '../../config/metrics';

export class MetaScheduler implements SchedulerPolicy {
  public static _mockExtractionFailure = false;
  private candidateService: CandidateService;
  private lastDecision: PolicyDecision | null = null;
  private selectorVersion = "5.4.0";
  private runType: "PRODUCTION" | "LAB";

  constructor(candidateService?: CandidateService, runType: "PRODUCTION" | "LAB" = "PRODUCTION") {
    this.candidateService = candidateService || new CandidateService();
    this.runType = runType;
  }

  public getDecision(): PolicyDecision | null {
    return this.lastDecision;
  }

  public getSelectorVersion(): string {
    return this.selectorVersion;
  }

  private async persistRunTrace(record: any) {
    try {
      await db.insert(schedulerRuns).values({
        runType: this.runType,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        referenceTime: record.referenceTime,

        selectedPolicy: record.selectedPolicy || null,
        selectionReason: record.selectionReason || null,
        selectorVersion: this.selectorVersion,

        taskCount: record.taskCount || null,
        totalTaskDemandSeconds: record.totalTaskDemandSeconds || null,
        usableCapacitySeconds: record.usableCapacitySeconds || null,

        loadPressure: record.loadPressure || null,
        medianDeadlinePressure: record.medianDeadlinePressure || null,
        p10DeadlinePressure: record.p10DeadlinePressure || null,
        tightTaskFraction: record.tightTaskFraction || null,
        highPriorityFraction: record.highPriorityFraction || null,

        meanGapSeconds: record.meanGapSeconds || null,
        largestGapSeconds: record.largestGapSeconds || null,
        fragmentationPressure: record.fragmentationPressure || null,

        scheduledCount: record.scheduledCount || null,
        unscheduledCount: record.unscheduledCount || null,
        executionStatus: record.executionStatus,
        errorMessage: record.errorMessage || null,
      });
    } catch (e) {
      // Do not crash the application if observability write fails!
      logger.error({ err: e }, "Failed to persist MetaScheduler execution trace");
    }
  }

  async schedulePendingTasks(): Promise<SchedulerResult> {
    const startedAt = new Date();
    const referenceTime = new Date();

    const pendingTasks = await db.select()
      .from(missionTasks)
      .where(sql`${missionTasks.status} = 'PENDING'`);
    
    const availableWindows = await db.select().from(contactWindows);
    const existingReservations = await db.select().from(reservations);

    const mTasks: Task[] = pendingTasks.map(t => ({
      id: t.id,
      priority: t.priority,
      duration_ms: t.durationSeconds * 1000,
      deadline: t.deadline
    }));

    const mWindows: ContactWindow[] = availableWindows.map(w => ({
      id: w.id,
      ground_station_id: w.groundStationId,
      aos: w.aos.toISOString(),
      los: w.los.toISOString()
    }));

    const mReservations: Reservation[] = existingReservations.map(r => ({
      id: r.id,
      ground_station_id: r.groundStationId,
      allocated_start: r.allocatedStart.toISOString(),
      allocated_end: r.allocatedEnd.toISOString()
    }));

    let features: WorkloadFeatures;
    try {
      if (MetaScheduler._mockExtractionFailure) throw new Error("MOCKED_EXTRACTION_FAILURE");
      features = calculateFeatures(mTasks, mWindows, mReservations, referenceTime);
    } catch (err: any) {
      await this.persistRunTrace({
        startedAt,
        completedAt: new Date(),
        referenceTime,
        taskCount: mTasks.length,
        executionStatus: "FAILED_FEATURE_EXTRACTION",
        errorMessage: err.message
      });
      throw new Error(`Feature extraction failed: ${err.message}`);
    }

    const decision = selectPolicy(features);
    this.lastDecision = decision;

    let underlyingScheduler: SchedulerPolicy;
    switch (decision.policy) {
      case 'FCFS':
        underlyingScheduler = new FcfsScheduler(this.candidateService);
        break;
      case 'PRIORITY':
        underlyingScheduler = new PriorityScheduler(this.candidateService);
        break;
      case 'HYBRID_SLACK':
        underlyingScheduler = new HybridScheduler(this.candidateService, "SLACK", referenceTime);
        break;
    }

    let result: SchedulerResult;
    try {
      const scheduleStart = performance.now();
      result = await underlyingScheduler.schedulePendingTasks();
      const durationMs = performance.now() - scheduleStart;
      
      // Track duration and success run
      if (this.runType === "PRODUCTION") {
        schedulerDurationMs.observe(durationMs);
        schedulerRunsTotal.inc({ result: "success" });
      }
    } catch (err: any) {
      if (this.runType === "PRODUCTION") {
        schedulerRunsTotal.inc({ result: "error" });
      }
      await this.persistRunTrace({
        startedAt,
        completedAt: new Date(),
        referenceTime,
        taskCount: features.taskCount,
        totalTaskDemandSeconds: features.totalTaskDemandSeconds,
        usableCapacitySeconds: features.usableCapacitySeconds,
        loadPressure: features.loadPressure,
        medianDeadlinePressure: features.medianDeadlinePressure,
        p10DeadlinePressure: features.p10DeadlinePressure,
        tightTaskFraction: features.tightTaskFraction,
        highPriorityFraction: features.highPriorityFraction,
        meanGapSeconds: features.meanGapSeconds,
        largestGapSeconds: features.largestGapSeconds,
        fragmentationPressure: features.fragmentationPressure,
        selectedPolicy: decision.policy,
        selectionReason: decision.reason,
        executionStatus: "FAILED_EXECUTION",
        errorMessage: err.message
      });
      throw err;
    }

    // Scheduling succeeded
    const executionStatus = result.unscheduled > 0 ? "PARTIAL" : "SUCCESS";

    await this.persistRunTrace({
      startedAt,
      completedAt: new Date(),
      referenceTime,
      taskCount: features.taskCount,
      totalTaskDemandSeconds: features.totalTaskDemandSeconds,
      usableCapacitySeconds: features.usableCapacitySeconds,
      loadPressure: features.loadPressure,
      medianDeadlinePressure: features.medianDeadlinePressure,
      p10DeadlinePressure: features.p10DeadlinePressure,
      tightTaskFraction: features.tightTaskFraction,
      highPriorityFraction: features.highPriorityFraction,
      meanGapSeconds: features.meanGapSeconds,
      largestGapSeconds: features.largestGapSeconds,
      fragmentationPressure: features.fragmentationPressure,
      selectedPolicy: decision.policy,
      selectionReason: decision.reason,
      scheduledCount: result.scheduled,
      unscheduledCount: result.unscheduled,
      executionStatus: executionStatus,
    });

    return result;
  }
}
