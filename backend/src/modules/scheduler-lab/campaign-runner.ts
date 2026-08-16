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
      campaignSeeds: { type: "string" },
      outDir: { type: "string" }
    }
  });

  const isPilot = values.pilot || false;
  const seedsStr = values.campaignSeeds || "10101,20202,30303,40404,50505";
  const seeds = isPilot ? ["10101"] : seedsStr.split(",");
  
  const taskCounts = isPilot ? [50, 100] : [50, 100, 250, 500];
  const deadlines = isPilot ? ["LOOSE", "TIGHT"] : ["LOOSE", "MEDIUM", "TIGHT"];
  const priorities = isPilot ? ["BALANCED", "HIGH_HEAVY"] : ["BALANCED", "HIGH_HEAVY", "LOW_HEAVY"];
  const durations = isPilot ? ["SHORT", "LONG"] : ["SHORT", "MIXED", "LONG"];
  
  const policies = ["FCFS", "PRIORITY", "HYBRID_SLACK", "HYBRID_RATIO"] as const;

  const totalConfigs = taskCounts.length * deadlines.length * priorities.length * durations.length * seeds.length;
  const totalRuns = totalConfigs * policies.length;

  console.log(`Starting ${isPilot ? "PILOT " : ""}Campaign...`);
  console.log(`Total Configs: ${totalConfigs}`);
  console.log(`Total Runs: ${totalRuns}\n`);

  const outDir = values.outDir || "results";
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const dateStr = new Date().toISOString().split("T")[0];
  const csvPath = path.join(outDir, `campaign-${dateStr}.csv`);
  const validationPath = path.join(outDir, `regime-validation-${dateStr}.txt`);

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
    "duration_ms"
  ];
  fs.writeFileSync(csvPath, csvHeaders.join(",") + "\n");
  fs.writeFileSync(validationPath, "Regime Validations:\n\n");

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

            // Regime Validation (Once per configuration)
            const wg = new WorkloadGenerator(config);
            const workload = wg.generate();
            let avgTaskDuration = 0, avgWindowDuration = 0, avgSlack = 0;
            if (workload.tasks.length > 0) {
              avgTaskDuration = workload.tasks.reduce((sum, t) => sum + t.durationSeconds, 0) / workload.tasks.length;
              avgSlack = workload.tasks.reduce((sum, t) => sum + (t.deadline.getTime() - t.createdAt.getTime())/1000, 0) / workload.tasks.length;
            }
            if (workload.windows.length > 0) {
              avgWindowDuration = workload.windows.reduce((sum, w) => sum + w.durationSeconds, 0) / workload.windows.length;
            }
            
            fs.appendFileSync(validationPath, `Config: ${expId}\n`);
            fs.appendFileSync(validationPath, `  Avg Task Duration: ${avgTaskDuration.toFixed(1)}s\n`);
            fs.appendFileSync(validationPath, `  Avg Deadline Offset: ${avgSlack.toFixed(1)}s\n`);
            fs.appendFileSync(validationPath, `  Avg Window Duration: ${avgWindowDuration.toFixed(1)}s\n\n`);

            let baselineFingerprint = "";

            // Inner loop: Policies
            for (const policy of policies) {
              const startMs = Date.now();
              const { metrics, fingerprint } = await runPolicyExperiment(policy, config);
              const durationMs = Date.now() - startMs;

              if (baselineFingerprint === "") {
                baselineFingerprint = fingerprint;
              } else if (baselineFingerprint !== fingerprint) {
                console.error(`\nFATAL: Fingerprint mismatch for ${expId} under ${policy}! Aborting.`);
                process.exit(1);
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
                metrics.schedulingSuccessRate,
                metrics.deadlineMissRate,
                metrics.noWindowRate,
                metrics.averageWaitingTimeMs,
                metrics.p95WaitingTimeMs,
                metrics.maxWaitingTimeMs,
                metrics.contactWindowUtilization,
                metrics.groundStationUtilization,
                metrics.priorityWeightedSuccess,
                metrics.highPrioritySuccess,
                metrics.mediumPrioritySuccess,
                metrics.lowPrioritySuccess,
                fingerprint,
                durationMs
              ].map(v => typeof v === 'number' ? v.toFixed(4) : v);

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
