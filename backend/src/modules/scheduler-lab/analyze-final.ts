import fs from "fs";
import path from "path";

function readLatestCsv(dir: string) {
  const files = fs.readdirSync(dir).filter(f => f.startsWith("validation-campaign") && f.endsWith(".csv"));
  if (files.length === 0) throw new Error("No validation CSV found in " + dir);
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, files[0]!);
}

const csvPath = readLatestCsv("results");
console.log(`Analyzing: ${csvPath}\n`);

const content = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
const headerLine = content[0]!;
const headers = headerLine.split(",");
const rows = content.slice(1).filter(line => line.trim().length > 0);

console.log(`1. Total rows: ${rows.length}`);

// Group by experiment_id
const expMap = new Map<string, any[]>();
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
}

// Lexicographic Oracle Comparator
function compareRuns(a: any, b: any): number {
  const missA = a.deadline_miss_rate;
  const missB = b.deadline_miss_rate;
  if (Math.abs(missA - missB) > 0.0001) return missA - missB; // lower is better

  const succA = a.success_rate;
  const succB = b.success_rate;
  if (Math.abs(succA - succB) > 0.0001) return succB - succA; // higher is better

  const prioA = a.priority_weighted_success;
  const prioB = b.priority_weighted_success;
  if (Math.abs(prioA - prioB) > 0.0001) return prioB - prioA; // higher is better

  const p95A = a.p95_wait_ms;
  const p95B = b.p95_wait_ms;
  if (Math.abs(p95A - p95B) > 0.1) return p95A - p95B; // lower is better

  return 0; // TIE
}

const candidatePolicies = ["FCFS", "PRIORITY", "HYBRID_SLACK"];
let oracleMatches = 0;
let exactOracleMatches = 0;
let metaErrors = 0;
let tieSets = 0;
let fingerprintFailures = 0;

let sumMetaScheduled = 0;
let sumMetaWeighted = 0;
let sumMetaMisses = 0;
let sumMetaP95 = 0;

let sumOracleScheduled = 0;
let sumOracleWeighted = 0;
let sumOracleMisses = 0;
let sumOracleP95 = 0;

const policyWinCounts: Record<string, number> = { FCFS: 0, PRIORITY: 0, HYBRID_SLACK: 0, TIE: 0 };
const metaDecisions: Record<string, number> = { FCFS: 0, PRIORITY: 0, HYBRID_SLACK: 0 };

for (const [expId, runList] of expMap.entries()) {
  const fingerprints = new Set(runList.map(r => r.workload_fingerprint));
  if (fingerprints.size !== 1) fingerprintFailures++;

  const candidates = runList.filter(r => candidatePolicies.includes(r.policy));
  const metaRun = runList.find(r => r.policy === "META");
  
  if (candidates.length !== 3 || !metaRun) continue;

  candidates.sort(compareRuns);
  const best = candidates[0];
  const bestSet = candidates.filter(c => compareRuns(best, c) === 0);
  
  if (bestSet.length > 1) tieSets++;
  if (bestSet.length === 1) policyWinCounts[bestSet[0]!.policy]!++;
  else policyWinCounts["TIE"]!++;

  if (metaRun.meta_selected_policy) {
    metaDecisions[metaRun.meta_selected_policy] = (metaDecisions[metaRun.meta_selected_policy] || 0) + 1;
  }

  if (compareRuns(best, metaRun) === 0) oracleMatches++;
  else metaErrors++;

  // Exact match means it picked the policy that is uniquely optimal OR in the best set
  const pickedPolicy = metaRun.meta_selected_policy;
  if (bestSet.some(b => b.policy === pickedPolicy)) {
    exactOracleMatches++;
  }

  // Averages summation
  sumMetaScheduled += metaRun.success_rate;
  sumMetaWeighted += metaRun.priority_weighted_success;
  sumMetaMisses += metaRun.deadline_miss_rate;
  sumMetaP95 += metaRun.p95_wait_ms;

  sumOracleScheduled += best.success_rate;
  sumOracleWeighted += best.priority_weighted_success;
  sumOracleMisses += best.deadline_miss_rate;
  sumOracleP95 += best.p95_wait_ms;
}

const n = expMap.size;
console.log(`Fingerprint validation: ${fingerprintFailures === 0 ? "PASS" : "FAIL (" + fingerprintFailures + " mismatches)"}`);

console.log(`\n| Metric | Final |`);
console.log(`|---|---:|`);
console.log(`| Meta scheduled | ${(sumMetaScheduled / n * 100).toFixed(1)}% |`);
console.log(`| Weighted success | ${(sumMetaWeighted / n * 100).toFixed(1)}% |`);
console.log(`| Deadline misses | ${(sumMetaMisses / n * 100).toFixed(1)}% |`);
console.log(`| P95 wait | ${(sumMetaP95 / n / 1000).toFixed(0)} s |`);
console.log(`| Oracle miss regret | ${((sumMetaMisses - sumOracleMisses) / n * 100).toFixed(2)}% |`);
console.log(`| Oracle throughput regret | ${((sumOracleScheduled - sumMetaScheduled) / n * 100).toFixed(2)}% |`);
console.log(`| Oracle weighted-success regret | ${((sumOracleWeighted - sumMetaWeighted) / n * 100).toFixed(2)}% |`);
console.log(`| Oracle P95 regret | ${((sumMetaP95 - sumOracleP95) / n / 1000).toFixed(0)} s |`);
console.log(`| Top-set accuracy | ${((oracleMatches / n) * 100).toFixed(1)}% |`);
console.log(`| Exact Oracle accuracy | ${((exactOracleMatches / n) * 100).toFixed(1)}% |`);

console.log(`\nSelected policy distribution:`);
console.log(`FCFS:         ${metaDecisions.FCFS}`);
console.log(`PRIORITY:     ${metaDecisions.PRIORITY}`);
console.log(`HYBRID_SLACK: ${metaDecisions.HYBRID_SLACK}`);
