import { guardLabDatabase } from "./lab-db-guard";
guardLabDatabase();

import { pool } from "../../db/client";
import { runPolicyExperiment } from "./policy-runner";
import { WorkloadConfig } from "./types";
import { WorkloadGenerator } from "./workload-generator";
import { parseArgs } from "util";
import fs from "fs";
import path from "path";

async function run() {
  const { values } = parseArgs({
    options: {
      pilot: { type: "boolean" },
      outDir: { type: "string" }
    }
  });

  const isPilot = values.pilot || false;
  // Use new unseen seeds for Stage 5.3 Blind Validation
  const seeds = isPilot ? ["202601"] : ["202601", "202602", "202603", "202604", "202605"];
  
  const taskCounts = isPilot ? [50, 100] : [50, 100, 250, 500];
  const deadlines = isPilot ? ["LOOSE", "TIGHT"] : ["LOOSE", "MEDIUM", "TIGHT"];
  const priorities = isPilot ? ["BALANCED", "HIGH_HEAVY"] : ["BALANCED", "HIGH_HEAVY", "LOW_HEAVY"];
  const durations = isPilot ? ["SHORT", "LONG"] : ["SHORT", "MIXED", "LONG"];
  
  const policies = ["FCFS", "PRIORITY", "HYBRID_SLACK", "META"] as const;

  const totalConfigs = taskCounts.length * deadlines.length * priorities.length * durations.length * seeds.length;
  const totalRuns = totalConfigs * policies.length;

  console.log(`Starting ${isPilot ? "PILOT " : ""}Meta Validation Campaign...`);
  console.log(`Total Configs: ${totalConfigs}`);
  console.log(`Total Runs: ${totalRuns}\n`);

  const outDir = values.outDir || "results";
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const csvPath = path.join(outDir, `validation-campaign.csv`);

  // Write CSV Header
  const csvHeaders = [
    "experiment_id",
    "seed",
    "task_count",
    "deadline_regime",
    "priority_distribution",
    "duration_distribution",
    "policy",
    "scheduled",
    "unscheduled",
    "success_rate",
    "deadline_miss_rate",
    "no_feasible_window_rate",
    "avg_wait_ms",
    "p95_wait_ms",
    "max_wait_ms",
    "window_utilization",
    "station_utilization",
    "priority_weighted_success",
    "high_priority_success",
    "medium_priority_success",
    "low_priority_success",
    "workload_fingerprint",
    "duration_ms",
    // Meta specific features
    "meta_selected_policy",
    "meta_reason",
    "meta_load_pressure",
    "meta_p10_deadline_pressure",
    "meta_tight_task_fraction",
    "meta_high_priority_fraction",
    "meta_fragmentation_pressure",
    "meta_selector_version"
  ];
  fs.writeFileSync(csvPath, csvHeaders.join(",") + "\n");

  let completedRuns = 0;
  
  // Outer loop: Configurations
  for (const seed of seeds) {
    for (const taskCount of taskCounts) {
      for (const deadlineRegime of deadlines as any[]) {
        for (const priorityDistribution of priorities as any[]) {
          for (const durationDistribution of durations as any[]) {
            
            const expId = `${seed}-${taskCount}-${deadlineRegime}-${priorityDistribution}-${durationDistribution}`;
            const config: WorkloadConfig = {
              seed,
              referenceTime: new Date("2026-08-16T00:00:00Z"),
              taskCount,
              satelliteCount: 5,
              stationCount: 2,
              deadlineRegime,
              priorityDistribution,
              durationDistribution,
              arrivalSpreadSeconds: 86400
            };

            const wg = new WorkloadGenerator(config);
            const workload = wg.generate();

            let baselineFingerprint = "";

            // Inner loop: Policies
            for (const policy of policies) {
              const startMs = Date.now();
              // Pass the exact generated workload directly so it is identical for all 4 runs
              const { metrics, fingerprint, metaDecision } = await runPolicyExperiment(policy, workload);
              const durationMs = Date.now() - startMs;

              if (baselineFingerprint === "") {
                baselineFingerprint = fingerprint;
              } else if (baselineFingerprint !== fingerprint) {
                console.error(`\nFATAL: Fingerprint mismatch for ${expId} under ${policy}! Aborting.`);
                process.exit(1);
              }

              let metaPol = "", metaReason = "", metaLoad = "", metaP10 = "", metaTight = "", metaHighPri = "", metaFrag = "", metaVer = "";
              if (policy === "META" && metaDecision) {
                metaPol = metaDecision.policy;
                metaReason = metaDecision.reason;
                metaLoad = metaDecision.features.loadPressure.toFixed(4);
                metaP10 = metaDecision.features.p10DeadlinePressure.toFixed(4);
                metaTight = metaDecision.features.tightTaskFraction.toFixed(4);
                metaHighPri = metaDecision.features.highPriorityFraction.toFixed(4);
                metaFrag = metaDecision.features.fragmentationPressure.toFixed(4);
                metaVer = "5.2.0";
              }

              const row = [
                expId,
                seed,
                taskCount,
                deadlineRegime,
                priorityDistribution,
                durationDistribution,
                policy,
                metrics.scheduledCount,
                metrics.unscheduledCount,
                metrics.schedulingSuccessRate.toFixed(4),
                metrics.deadlineMissRate.toFixed(4),
                metrics.noWindowRate.toFixed(4),
                metrics.averageWaitingTimeMs.toFixed(1),
                metrics.p95WaitingTimeMs.toFixed(1),
                metrics.maxWaitingTimeMs.toFixed(1),
                metrics.contactWindowUtilization.toFixed(4),
                metrics.groundStationUtilization.toFixed(4),
                metrics.priorityWeightedSuccess.toFixed(4),
                metrics.highPrioritySuccess.toFixed(4),
                metrics.mediumPrioritySuccess.toFixed(4),
                metrics.lowPrioritySuccess.toFixed(4),
                fingerprint,
                durationMs,
                metaPol,
                metaReason,
                metaLoad,
                metaP10,
                metaTight,
                metaHighPri,
                metaFrag,
                metaVer
              ];

              fs.appendFileSync(csvPath, row.join(",") + "\n");
              
              completedRuns++;
              process.stdout.write(`\rCompleted ${completedRuns} / ${totalRuns}`);
            }
          }
        }
      }
    }
  }
  
  console.log(`\n\nCampaign finished! Results in ${csvPath}`);
}

run().catch(err => {
  console.error("Experiment failed", err);
  process.exit(1);
}).finally(async () => {
  await pool.end();
});
