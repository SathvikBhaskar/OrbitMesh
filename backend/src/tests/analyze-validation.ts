import fs from 'fs';
import path from 'path';

// Define the precise tolerances
const TOLERANCES = {
  missRate: 1e-9,
  scheduledRate: 1e-9,
  weightedSuccess: 1e-9,
  p95WaitMs: 1.0
};

function readCSV(filePath: string) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const headers = lines[0]!.split(',');
  return lines.slice(1).map(line => {
    const values = line.split(',');
    const row: any = {};
    headers.forEach((h, i) => {
      const val = values[i];
      if (val === undefined || val === '') row[h] = null;
      else if (!isNaN(Number(val))) row[h] = Number(val);
      else row[h] = val;
    });
    return row;
  });
}

function percentile(arr: number[], p: number) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base]! + rest * (sorted[base + 1]! - sorted[base]!);
  } else {
    return sorted[base]!;
  }
}

function median(arr: number[]) {
  return percentile(arr, 0.5);
}

function getOracle(group: any[]) {
  // Only evaluate the three fixed candidates
  let candidates = group.filter(r => r.policy !== 'META');
  
  // 1. Deadline Safety: Minimize miss rate
  let minMiss = Math.min(...candidates.map(c => c.deadline_miss_rate));
  candidates = candidates.filter(c => c.deadline_miss_rate <= minMiss + TOLERANCES.missRate);
  
  // 2. Throughput: Maximize scheduled rate
  let maxScheduled = Math.max(...candidates.map(c => c.success_rate));
  candidates = candidates.filter(c => c.success_rate >= maxScheduled - TOLERANCES.scheduledRate);
  
  // 3. Priority Value: Maximize weighted success
  let maxWeighted = Math.max(...candidates.map(c => c.priority_weighted_success));
  candidates = candidates.filter(c => c.priority_weighted_success >= maxWeighted - TOLERANCES.weightedSuccess);
  
  // 4. Latency: Minimize P95 Wait
  let minP95 = Math.min(...candidates.map(c => c.p95_wait_ms));
  candidates = candidates.filter(c => c.p95_wait_ms <= minP95 + TOLERANCES.p95WaitMs);

  return candidates; // Oracle Optimal Set
}

function analyze() {
  const csvPath = path.join(__dirname, '../../results/validation-campaign.csv');
  if (!fs.existsSync(csvPath)) {
    console.error(`Validation CSV not found at ${csvPath}`);
    return;
  }

  const data = readCSV(csvPath);
  
  const groups = new Map<string, any[]>();
  for (const row of data) {
    if (!groups.has(row.experiment_id)) {
      groups.set(row.experiment_id, []);
    }
    groups.get(row.experiment_id)!.push(row);
  }

  let totalWorkloads = 0;
  let topSetMatches = 0;
  let exactMatches = 0;
  
  const regrets = {
    miss: [] as number[],
    throughput: [] as number[],
    weighted: [] as number[],
    p95: [] as number[]
  };

  const distribution = {
    FCFS: 0,
    PRIORITY: 0,
    HYBRID_SLACK: 0
  };

  const regimeAccuracies: Record<string, { total: number, matches: number }> = {};
  
  function trackRegime(name: string, isMatch: boolean) {
    if (!regimeAccuracies[name]) regimeAccuracies[name] = { total: 0, matches: 0 };
    regimeAccuracies[name].total++;
    if (isMatch) regimeAccuracies[name].matches++;
  }

  const aggregates = {
    FCFS: { scheduled: [] as number[], weighted: [] as number[], misses: [] as number[], p95: [] as number[], max: [] as number[] },
    PRIORITY: { scheduled: [] as number[], weighted: [] as number[], misses: [] as number[], p95: [] as number[], max: [] as number[] },
    HYBRID_SLACK: { scheduled: [] as number[], weighted: [] as number[], misses: [] as number[], p95: [] as number[], max: [] as number[] },
    META: { scheduled: [] as number[], weighted: [] as number[], misses: [] as number[], p95: [] as number[], max: [] as number[] }
  };

  for (const [expId, group] of groups.entries()) {
    if (group.length !== 4) continue;
    
    totalWorkloads++;
    const oracleCandidates = getOracle(group);
    const metaRun = group.find(r => r.policy === 'META');
    
    if (!metaRun) continue;

    const metaSelection = metaRun.meta_selected_policy;
    distribution[metaSelection as keyof typeof distribution]++;

    // Accuracy
    const isTopSet = oracleCandidates.some(c => c.policy === metaSelection);
    const isExact = oracleCandidates.length === 1 && oracleCandidates[0].policy === metaSelection;

    if (isTopSet) topSetMatches++;
    if (isExact) exactMatches++;

    // Track regimes
    const taskCount = group[0].task_count;
    const deadline = group[0].deadline_regime;
    const priority = group[0].priority_distribution;
    const duration = group[0].duration_distribution;

    trackRegime(`Tasks: ${taskCount}`, isTopSet);
    trackRegime(`Deadline: ${deadline}`, isTopSet);
    trackRegime(`Priority: ${priority}`, isTopSet);
    trackRegime(`Duration: ${duration}`, isTopSet);

    // Regret Calculation (Compared to the absolute best value across all Oracle Candidates for that specific metric)
    // Wait, the Oracle Optimal Set represents the policies that survived the Lexicographic filter. 
    // All policies in the Optimal Set have identically optimal performance (within tolerance).
    // We can just use oracleCandidates[0] as the reference for Regret.
    const oracleRef = oracleCandidates[0];
    
    const rMiss = Math.max(0, metaRun.deadline_miss_rate - oracleRef.deadline_miss_rate);
    const rThru = Math.max(0, oracleRef.success_rate - metaRun.success_rate);
    const rWgt = Math.max(0, oracleRef.priority_weighted_success - metaRun.priority_weighted_success);
    const rP95 = Math.max(0, metaRun.p95_wait_ms - oracleRef.p95_wait_ms);

    regrets.miss.push(rMiss);
    regrets.throughput.push(rThru);
    regrets.weighted.push(rWgt);
    regrets.p95.push(rP95);

    // Track aggregates
    for (const run of group) {
      const p = run.policy as keyof typeof aggregates;
      aggregates[p].scheduled.push(run.success_rate);
      aggregates[p].weighted.push(run.priority_weighted_success);
      aggregates[p].misses.push(run.deadline_miss_rate);
      aggregates[p].p95.push(run.p95_wait_ms);
      aggregates[p].max.push(run.max_wait_ms);
    }
  }

  // Formatting output
  console.log("=== META-SCHEDULER BLIND VALIDATION RESULTS ===\n");

  // Performance Table
  console.log("1. Overall Policy Performance (Mean)");
  console.log("Metric | FCFS | Priority | Slack | Meta");
  console.log("--- | --- | --- | --- | ---");
  const fmt = (key: keyof typeof aggregates.FCFS, pct: boolean = false) => {
    return ["FCFS", "PRIORITY", "HYBRID_SLACK", "META"].map(p => {
      const arr = aggregates[p as keyof typeof aggregates][key];
      const val = arr.reduce((a, b) => a + b, 0) / arr.length;
      return pct ? (val * 100).toFixed(1) + "%" : val.toFixed(4);
    }).join(" | ");
  };
  
  console.log(`Scheduled % | ${fmt("scheduled", true)}`);
  console.log(`Weighted success | ${fmt("weighted", true)}`);
  console.log(`Deadline misses | ${fmt("misses", true)}`);
  
  const fmtNum = (key: keyof typeof aggregates.FCFS) => {
    return ["FCFS", "PRIORITY", "HYBRID_SLACK", "META"].map(p => {
      const arr = aggregates[p as keyof typeof aggregates][key];
      const val = arr.reduce((a, b) => a + b, 0) / arr.length;
      return Math.round(val).toLocaleString() + "s";
    }).join(" | ");
  };
  console.log(`P95 wait | ${fmtNum("p95").replace(/s/g, "ms")}`);
  console.log(`Max wait | ${fmtNum("max").replace(/s/g, "ms")}\n`);

  // Regret Analysis
  console.log("2. Meta-Scheduler Regret");
  console.log("Metric | Mean | Median | P95 | Max | Zero-Regret %");
  console.log("--- | --- | --- | --- | --- | ---");
  const calcRegretRow = (name: string, arr: number[], pct: boolean) => {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const med = median(arr);
    const p95 = percentile(arr, 0.95);
    const max = Math.max(...arr);
    const zeros = arr.filter(x => x <= (pct ? 1e-6 : 1.0)).length; // small tolerance for float math
    const zeroPct = (zeros / arr.length * 100).toFixed(1) + "%";
    
    if (pct) {
      return `${name} | ${(mean*100).toFixed(2)}% | ${(med*100).toFixed(2)}% | ${(p95*100).toFixed(2)}% | ${(max*100).toFixed(2)}% | ${zeroPct}`;
    } else {
      return `${name} | ${mean.toFixed(1)}ms | ${med.toFixed(1)}ms | ${p95.toFixed(1)}ms | ${max.toFixed(1)}ms | ${zeroPct}`;
    }
  };
  console.log(calcRegretRow("Miss Rate Regret", regrets.miss, true));
  console.log(calcRegretRow("Throughput Regret", regrets.throughput, true));
  console.log(calcRegretRow("Weighted Success Regret", regrets.weighted, true));
  console.log(calcRegretRow("P95 Wait Regret", regrets.p95, false));
  console.log("");

  // Accuracy
  console.log("3. Meta-Scheduler Accuracy");
  console.log(`Overall Top-Set Accuracy: ${(topSetMatches / totalWorkloads * 100).toFixed(1)}% (${topSetMatches}/${totalWorkloads})`);
  console.log(`Overall Exact Accuracy:   ${(exactMatches / totalWorkloads * 100).toFixed(1)}% (${exactMatches}/${totalWorkloads})`);
  
  console.log("\nTop-Set Accuracy by Regime:");
  for (const [regime, stats] of Object.entries(regimeAccuracies)) {
    console.log(`- ${regime.padEnd(16)}: ${(stats.matches / stats.total * 100).toFixed(1)}% (${stats.matches}/${stats.total})`);
  }

  // Distribution
  console.log("\n4. Selection Distribution");
  console.log(`FCFS:       ${(distribution.FCFS / totalWorkloads * 100).toFixed(1)}%`);
  console.log(`Priority:   ${(distribution.PRIORITY / totalWorkloads * 100).toFixed(1)}%`);
  console.log(`Slack:      ${(distribution.HYBRID_SLACK / totalWorkloads * 100).toFixed(1)}%`);
}

analyze();
