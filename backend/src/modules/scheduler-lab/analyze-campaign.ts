import fs from "fs";
import path from "path";

function readLatestCsv(dir: string) {
  const files = fs.readdirSync(dir).filter(f => f.startsWith("campaign-") && f.endsWith(".csv"));
  if (files.length === 0) throw new Error("No campaign CSV found in " + dir);
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, files[0]!);
}

const csvPath = readLatestCsv("results");
console.log(`Analyzing: ${csvPath}\n`);

const content = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
const headerLine = content[0]!;
const headers = headerLine.split(",");
const rows = content.slice(1).filter(line => line.trim().length > 0);

console.log(`1. Total rows generated: ${rows.length}`);
console.log(`2. Failed experiments: ${rows.length < 2160 ? "YES (missing rows)" : "NO"}`);
console.log(`3. CSV validation result: ${rows.length === 2160 && headers.length > 20 ? "PASS" : "FAIL"}`);

// Group by experiment_id
const expMap = new Map<string, any[]>();
let fingerprintFailures = 0;
let totalDurationMs = 0;

for (const line of rows) {
  const cols = line.split(",");
  const obj: any = {};
  for (let i = 0; i < headers.length; i++) {
    const val = cols[i]!;
    obj[headers[i]!] = isNaN(Number(val)) ? val : Number(val);
  }
  const expId = obj.experiment_id;
  if (!expMap.has(expId)) expMap.set(expId, []);
  expMap.get(expId)!.push(obj);
  
  totalDurationMs += obj.duration_ms || 0;
}

let divergenceCount = 0;
const policies = ["FCFS", "PRIORITY", "HYBRID_SLACK", "HYBRID_RATIO"];
let totalExpCount = 0;

const winCounts = {
  success_rate: { FCFS: 0, PRIORITY: 0, HYBRID_SLACK: 0, HYBRID_RATIO: 0, TIE: 0 },
  deadline_miss_rate: { FCFS: 0, PRIORITY: 0, HYBRID_SLACK: 0, HYBRID_RATIO: 0, TIE: 0 },
  priority_weighted_success: { FCFS: 0, PRIORITY: 0, HYBRID_SLACK: 0, HYBRID_RATIO: 0, TIE: 0 },
  p95_wait_ms: { FCFS: 0, PRIORITY: 0, HYBRID_SLACK: 0, HYBRID_RATIO: 0, TIE: 0 }
};

for (const [expId, runList] of expMap.entries()) {
  totalExpCount++;
  // 4. Fingerprint Validation
  const fingerprints = new Set(runList.map(r => r.workload_fingerprint));
  if (fingerprints.size !== 1) {
    fingerprintFailures++;
  }

  // Divergence check (Slack vs Ratio)
  const slackRun = runList.find(r => r.policy === "HYBRID_SLACK");
  const ratioRun = runList.find(r => r.policy === "HYBRID_RATIO");
  
  if (slackRun && ratioRun) {
    const slackSig = `${slackRun.scheduled}-${slackRun.avg_wait_ms}-${slackRun.priority_weighted_success}`;
    const ratioSig = `${ratioRun.scheduled}-${ratioRun.avg_wait_ms}-${ratioRun.priority_weighted_success}`;
    if (slackSig !== ratioSig) {
      divergenceCount++;
    }
  }

  // Helper for win tracking
  const trackWins = (category: keyof typeof winCounts, valFn: (r: any) => number, isMin: boolean) => {
    // Only consider policies that actually ran/scheduled if required
    let validRuns = runList;
    if (category === "p95_wait_ms") {
      validRuns = runList.filter(r => r.scheduled > 0);
      if (validRuns.length === 0) return;
    }
    const vals = validRuns.map(valFn);
    const targetVal = isMin ? Math.min(...vals) : Math.max(...vals);
    const winners = validRuns.filter(r => valFn(r) === targetVal);
    if (winners.length === 1) {
      winCounts[category][winners[0]!.policy as keyof typeof winCounts["success_rate"]]++;
    } else {
      winCounts[category].TIE++;
    }
  };

  trackWins("success_rate", r => r.success_rate, false);
  trackWins("deadline_miss_rate", r => r.deadline_miss_rate, true);
  trackWins("priority_weighted_success", r => r.priority_weighted_success, false);
  trackWins("p95_wait_ms", r => r.p95_wait_ms, true);
}

console.log(`4. Fingerprint validation: ${fingerprintFailures === 0 ? "PASS" : "FAIL (" + fingerprintFailures + " mismatches)"}`);

function calculateAggregates(filterFn: (row: any) => boolean) {
  const data = rows.map(r => {
    const cols = r.split(",");
    const obj: any = {};
    for (let i = 0; i < headers.length; i++) {
      const val = cols[i]!;
      obj[headers[i]!] = isNaN(Number(val)) ? val : Number(val);
    }
    return obj;
  }).filter(filterFn);

  const aggs: any = {};
  for (const p of policies) {
    const pData = data.filter(d => d.policy === p);
    if (pData.length === 0) continue;
    
    aggs[p] = {
      scheduledPct: (pData.reduce((s, d) => s + d.success_rate, 0) / pData.length * 100).toFixed(1) + "%",
      missRatePct: (pData.reduce((s, d) => s + d.deadline_miss_rate, 0) / pData.length * 100).toFixed(1) + "%",
      avgP95: (pData.reduce((s, d) => s + d.p95_wait_ms, 0) / pData.length / 1000).toFixed(1) + "s",
      avgMaxWait: (pData.reduce((s, d) => s + d.max_wait_ms, 0) / pData.length / 1000).toFixed(1) + "s",
      avgWeightedSuccess: (pData.reduce((s, d) => s + d.priority_weighted_success, 0) / pData.length * 100).toFixed(1) + "%"
    };
  }
  return aggs;
}

function printTable(title: string, aggs: any) {
  console.log(`\n--- ${title} ---`);
  console.log(`Policy          Scheduled%   DeadlineMiss%   Avg P95      Avg MaxWait   WeightedSuccess%`);
  for (const p of policies) {
    if (!aggs[p]) continue;
    console.log(`${p.padEnd(15)} ${aggs[p].scheduledPct.padEnd(12)} ${aggs[p].missRatePct.padEnd(15)} ${aggs[p].avgP95.padEnd(12)} ${aggs[p].avgMaxWait.padEnd(13)} ${aggs[p].avgWeightedSuccess}`);
  }
}

console.log(`\n5. Aggregate Policy Metrics`);
printTable("OVERALL", calculateAggregates(() => true));

console.log(`\n6. Results by Task Count`);
[50, 100, 250, 500].forEach(tc => {
  printTable(`Task Count: ${tc}`, calculateAggregates(r => r.task_count === tc));
});

console.log(`\n7. Results by Deadline Regime`);
["LOOSE", "MEDIUM", "TIGHT"].forEach(dr => {
  printTable(`Deadline Regime: ${dr}`, calculateAggregates(r => r.deadline_regime === dr));
});

console.log(`\n8. Results by Priority Distribution`);
["BALANCED", "HIGH_HEAVY", "LOW_HEAVY"].forEach(pd => {
  printTable(`Priority Distribution: ${pd}`, calculateAggregates(r => r.priority_distribution === pd));
});

console.log(`\n9. Results by Duration Distribution`);
["SHORT", "MIXED", "LONG"].forEach(dd => {
  printTable(`Duration Distribution: ${dd}`, calculateAggregates(r => r.duration_distribution === dd));
});

console.log(`\n10. Policy Win Counts (out of ${totalExpCount} workloads)`);
console.log(`                     FCFS   PRIORITY   SLACK   RATIO   TIE`);
console.log(`Success rate         ${winCounts.success_rate.FCFS.toString().padEnd(6)} ${winCounts.success_rate.PRIORITY.toString().padEnd(10)} ${winCounts.success_rate.HYBRID_SLACK.toString().padEnd(7)} ${winCounts.success_rate.HYBRID_RATIO.toString().padEnd(7)} ${winCounts.success_rate.TIE}`);
console.log(`Deadline miss        ${winCounts.deadline_miss_rate.FCFS.toString().padEnd(6)} ${winCounts.deadline_miss_rate.PRIORITY.toString().padEnd(10)} ${winCounts.deadline_miss_rate.HYBRID_SLACK.toString().padEnd(7)} ${winCounts.deadline_miss_rate.HYBRID_RATIO.toString().padEnd(7)} ${winCounts.deadline_miss_rate.TIE}`);
console.log(`Weighted success     ${winCounts.priority_weighted_success.FCFS.toString().padEnd(6)} ${winCounts.priority_weighted_success.PRIORITY.toString().padEnd(10)} ${winCounts.priority_weighted_success.HYBRID_SLACK.toString().padEnd(7)} ${winCounts.priority_weighted_success.HYBRID_RATIO.toString().padEnd(7)} ${winCounts.priority_weighted_success.TIE}`);
console.log(`P95 wait             ${winCounts.p95_wait_ms.FCFS.toString().padEnd(6)} ${winCounts.p95_wait_ms.PRIORITY.toString().padEnd(10)} ${winCounts.p95_wait_ms.HYBRID_SLACK.toString().padEnd(7)} ${winCounts.p95_wait_ms.HYBRID_RATIO.toString().padEnd(7)} ${winCounts.p95_wait_ms.TIE}`);

console.log(`\n11. Hybrid Slack vs Hybrid Ratio Divergence`);
const divPct = ((divergenceCount / totalExpCount) * 100).toFixed(1);
console.log(`Diverged on ${divergenceCount} / ${totalExpCount} workloads (${divPct}%)`);

console.log(`\n12. Total Campaign Runtime: ${(totalDurationMs / 1000 / 60).toFixed(1)} minutes (sum of individual config durations)`);
