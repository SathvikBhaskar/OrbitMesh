import { guardLabDatabase } from "./lab-db-guard";

// Execute the guard immediately before any imports that might connect to the DB
guardLabDatabase();

import { pool } from "../../db/client";
import { runPolicyExperiment } from "./policy-runner";
import { WorkloadConfig, MetricResults } from "./types";
import { parseArgs } from "util";
import fs from "fs";
import path from "path";

async function run() {
  const { values } = parseArgs({
    options: {
      policy: { type: "string" },
      tasks: { type: "string" },
      seed: { type: "string" },
      seeds: { type: "string" },
      compare: { type: "boolean" },
      out: { type: "string" }
    }
  });

  const seeds = values.seeds ? values.seeds.split(",") : [values.seed || "12345"];
  const tasks = parseInt(values.tasks || "100", 10);
  const isCompare = values.compare || false;
  const singlePolicy = values.policy?.toUpperCase() as "FCFS" | "PRIORITY";

  const config: WorkloadConfig = {
    seed: seeds[0]!,
    referenceTime: new Date("2026-08-16T00:00:00Z"),
    taskCount: tasks,
    satelliteCount: 5,
    stationCount: 2,
    deadlineRegime: 'LOOSE',
    priorityDistribution: 'BALANCED',
    durationDistribution: 'SHORT',
    arrivalSpreadSeconds: 86400 // 24 hours
  };

  if (isCompare) {
    if (seeds.length > 1) {
      console.log(`Running Multi-Seed Comparison for seeds: ${seeds.join(", ")} and tasks: ${tasks}...`);
      
      console.log(`\nSeed      Policy      Scheduled    Avg Wait    P95`);
      console.log(`--------------------------------------------------`);
      
      const allResults: any = { taskCount: tasks, results: {} };

      for (const s of seeds) {
        config.seed = s;
        const fcfsOutput = await runPolicyExperiment("FCFS", config);
        const priorityOutput = await runPolicyExperiment("PRIORITY", config);
        const slackOutput = await runPolicyExperiment("HYBRID_SLACK", config);
        const ratioOutput = await runPolicyExperiment("HYBRID_RATIO", config);

        if (fcfsOutput.fingerprint !== priorityOutput.fingerprint || 
            fcfsOutput.fingerprint !== slackOutput.fingerprint ||
            fcfsOutput.fingerprint !== ratioOutput.fingerprint) {
          console.error(`FATAL ERROR: Workload fingerprints did not match for seed ${s}!`);
          process.exit(1);
        }

        if (s === seeds[0]) {
          console.log(`Seed      Policy      Scheduled    Misses    Avg Wait    P95       W.Success`);
          console.log(`-----------------------------------------------------------------------------`);
        }

        allResults.results[s] = { 
          FCFS: fcfsOutput.metrics, 
          PRIORITY: priorityOutput.metrics,
          HYBRID_SLACK: slackOutput.metrics,
          HYBRID_RATIO: ratioOutput.metrics
        };

        const printRow = (policy: string, metrics: any) => {
          const misses = metrics.deadlineMissRate * config.taskCount;
          const wait = (metrics.averageWaitingTimeMs / 1000).toFixed(1);
          const p95 = (metrics.p95WaitingTimeMs / 1000).toFixed(1);
          const wSucc = (metrics.priorityWeightedSuccess * 100).toFixed(1) + "%";
          console.log(`${s.padEnd(9)} ${policy.padEnd(11)} ${metrics.scheduledCount.toString().padEnd(12)} ${misses.toString().padEnd(9)} ${wait.padEnd(11)} ${p95.padEnd(9)} ${wSucc}`);
        };

        printRow("FCFS", fcfsOutput.metrics);
        printRow("Priority", priorityOutput.metrics);
        printRow("Slack", slackOutput.metrics);
        printRow("Ratio", ratioOutput.metrics);
        console.log("");
      }

      if (values.out) {
        fs.writeFileSync(path.resolve(values.out), JSON.stringify(allResults, null, 2));
        console.log(`JSON results saved to ${values.out}`);
      }

    } else {
      const seed = seeds[0]!;
      config.seed = seed;
      console.log(`Running COMPARISON for seed: ${seed} and tasks: ${tasks}...`);
      const fcfsOutput = await runPolicyExperiment("FCFS", config);
      console.log("FCFS completed.");
      
      const priorityOutput = await runPolicyExperiment("PRIORITY", config);
      console.log("PRIORITY completed.");

      if (fcfsOutput.fingerprint !== priorityOutput.fingerprint) {
        console.error("FATAL ERROR: Workload fingerprints did not match!");
        process.exit(1);
      }

      const output = {
        seed,
        taskCount: tasks,
        fingerprint: fcfsOutput.fingerprint,
        results: {
          FCFS: fcfsOutput.metrics,
          PRIORITY: priorityOutput.metrics
        }
      };

      if (values.out) {
        fs.writeFileSync(path.resolve(values.out), JSON.stringify(output, null, 2));
        console.log(`JSON results saved to ${values.out}`);
      }

      console.log("\n=== Scheduler Comparison ===\n");
      console.log(`Workload\nTasks: ${tasks}\nSeed: ${seed}\nFingerprint: ${fcfsOutput.fingerprint}\n`);

      console.log(`FCFS`);
      console.log(`Scheduled:             ${output.results.FCFS.scheduledCount}`);
      console.log(`No feasible window:    ${output.results.FCFS.noWindowRate * total(output.results.FCFS)}`);
      console.log(`Deadline misses:       ${output.results.FCFS.deadlineMissRate * total(output.results.FCFS)}`);
      console.log(`Avg wait:              ${(output.results.FCFS.averageWaitingTimeMs / 1000).toFixed(1)} s`);
      console.log(`P95 wait:              ${(output.results.FCFS.p95WaitingTimeMs / 1000).toFixed(1)} s`);
      console.log(`Window utilization:    ${(output.results.FCFS.contactWindowUtilization * 100).toFixed(1)}%`);
      console.log(`Station utilization:   ${(output.results.FCFS.groundStationUtilization * 100).toFixed(1)}%`);
      console.log(`Priority wght success: ${(output.results.FCFS.priorityWeightedSuccess * 100).toFixed(1)}%\n`);

      console.log(`Priority`);
      console.log(`Scheduled:             ${output.results.PRIORITY.scheduledCount}`);
      console.log(`No feasible window:    ${output.results.PRIORITY.noWindowRate * total(output.results.PRIORITY)}`);
      console.log(`Deadline misses:       ${output.results.PRIORITY.deadlineMissRate * total(output.results.PRIORITY)}`);
      console.log(`Avg wait:              ${(output.results.PRIORITY.averageWaitingTimeMs / 1000).toFixed(1)} s`);
      console.log(`P95 wait:              ${(output.results.PRIORITY.p95WaitingTimeMs / 1000).toFixed(1)} s`);
      console.log(`Window utilization:    ${(output.results.PRIORITY.contactWindowUtilization * 100).toFixed(1)}%`);
      console.log(`Station utilization:   ${(output.results.PRIORITY.groundStationUtilization * 100).toFixed(1)}%`);
      console.log(`Priority wght success: ${(output.results.PRIORITY.priorityWeightedSuccess * 100).toFixed(1)}%\n`);
    }

  } else if (singlePolicy === "FCFS" || singlePolicy === "PRIORITY") {
    const seed = seeds[0]!;
    config.seed = seed;
    console.log(`Running ${singlePolicy} for seed: ${seed} and tasks: ${tasks}...`);
    const { metrics, fingerprint } = await runPolicyExperiment(singlePolicy, config);
    
    const output = {
      seed,
      taskCount: tasks,
      policy: singlePolicy,
      fingerprint,
      metrics
    };

    if (values.out) {
      fs.writeFileSync(path.resolve(values.out), JSON.stringify(output, null, 2));
      console.log(`JSON results saved to ${values.out}`);
    } else {
      console.log(JSON.stringify(output, null, 2));
    }
  } else {
    console.error("Please provide --policy (fcfs|priority) or --compare");
    process.exit(1);
  }
}

function total(metrics: MetricResults) {
  return metrics.scheduledCount + metrics.unscheduledCount;
}

run().catch(err => {
  console.error("Experiment failed", err);
  process.exit(1);
}).finally(async () => {
  await pool.end();
});
