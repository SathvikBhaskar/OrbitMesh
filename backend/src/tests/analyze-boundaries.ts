import fs from 'fs';
import path from 'path';

const dataPath = path.join(__dirname, 'combined-features.json');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

function isTie(valA: number, valB: number) {
  return Math.abs(valA - valB) < 0.0001;
}

const winnersCount = { FCFS: 0, PRIORITY: 0, SLACK: 0, TIE: 0 };
const ruleCoverage = { FCFS: 0, PRIORITY: 0, SLACK: 0 };

for (const exp of data) {
  const f = exp.features;
  const o = exp.outcomes;
  const policies = ['FCFS', 'PRIORITY', 'SLACK'] as const;

  // Let's compute actual objective winner for this experiment
  // Define what the objective SHOULD be based on user's hint:
  // Is priority heavy? Let's say if highPriorityFraction > 0.4
  // Is capacity heavy? Let's say if loadPressure > 0.8
  
  // Actually, to DERIVE boundaries, we should just see where PRIORITY gives significantly 
  // better weighted success than FCFS, and where SLACK gives better throughput than FCFS.

  const fSuccess = o.FCFS.throughput;
  const pSuccess = o.PRIORITY.throughput;
  const sSuccess = o.SLACK.throughput;

  const fWeight = o.FCFS.weightedSuccess;
  const pWeight = o.PRIORITY.weightedSuccess;
  const sWeight = o.SLACK.weightedSuccess;

  const fMiss = o.FCFS.deadlineMisses;
  const pMiss = o.PRIORITY.deadlineMisses;
  const sMiss = o.SLACK.deadlineMisses;

  const fP95 = o.FCFS.p95Wait;
  const pP95 = o.PRIORITY.p95Wait;
  const sP95 = o.SLACK.p95Wait;

  let bestThru = Math.max(fSuccess, pSuccess, sSuccess);
  let bestWeight = Math.max(fWeight, pWeight, sWeight);
  let minMiss = Math.min(fMiss, pMiss, sMiss);
  let minP95 = Math.min(fP95, pP95, sP95);

  // Print some interesting stats for feature regions:
  
  // When is priority-weighted success significantly better for PRIORITY?
  if (pWeight > fWeight && !isTie(pWeight, fWeight)) {
    // console.log(`PRIORITY wins weight: Load ${f.loadPressure.toFixed(2)}, PriorityFraction ${f.highPriorityFraction.toFixed(2)}`);
  }
}

// Let's write a simple grid search over thresholds to maximize the combined objective
// Let's define the meta-scheduler simulation:
function simulateMetaScheduler(Th_Load: number, Th_Pri: number, Th_Frag: number, Th_Tight: number) {
  let score = 0;
  let metaThroughput = 0;
  let metaWeight = 0;
  let metaMiss = 0;
  let metaP95 = 0;
  
  let selectionCounts = { FCFS: 0, PRIORITY: 0, SLACK: 0 };

  for (const exp of data) {
    const f = exp.features;
    const o = exp.outcomes;

    let selectedPolicy: 'FCFS' | 'PRIORITY' | 'SLACK' = 'FCFS';

    // Proposed rule logic:
    // Constraint 1: Deadline Safety. If deadlines are tight, favor the one that doesn't miss.
    // Wait, in our dataset, deadline misses are generally very low. The user said:
    // "Test 4: Tight deadlines. Don't blindly assert FCFS. Your Phase 4 data showed TIGHT: FCFS P95 4556, PRIORITY P95 4269... So we need to determine which objective matters under tight deadlines".

    // Let's just look at the raw data to see who wins!
    if (f.loadPressure >= Th_Load && f.highPriorityFraction >= Th_Pri) {
      selectedPolicy = 'PRIORITY';
    } else if (f.fragmentationPressure >= Th_Frag && f.loadPressure >= 0.3) {
      selectedPolicy = 'SLACK';
    } else {
      selectedPolicy = 'FCFS';
    }

    selectionCounts[selectedPolicy]++;

    const outcome = o[selectedPolicy];
    metaThroughput += outcome.throughput;
    metaWeight += outcome.weightedSuccess;
    metaMiss += outcome.deadlineMisses;
    metaP95 += outcome.p95Wait;
  }

  return { metaThroughput, metaWeight, metaMiss, metaP95, selectionCounts };
}

console.log("Analyzing base policies over all 540 workloads:");
for (const p of ['FCFS', 'PRIORITY', 'SLACK'] as const) {
  let thr = 0, wgt = 0, miss = 0, p95 = 0;
  for (const exp of data) {
    thr += exp.outcomes[p].throughput;
    wgt += exp.outcomes[p].weightedSuccess;
    miss += exp.outcomes[p].deadlineMisses;
    p95 += exp.outcomes[p].p95Wait;
  }
  console.log(`${p}: Thru ${(thr/540).toFixed(4)} | Wgt ${(wgt/540).toFixed(4)} | Miss ${(miss/540).toFixed(4)} | P95 ${(p95/540).toFixed(1)}`);
}

console.log("\nSearching for thresholds...");
const results = [];
for (let Th_Load = 0.5; Th_Load <= 1.0; Th_Load += 0.1) {
  for (let Th_Pri = 0.2; Th_Pri <= 0.6; Th_Pri += 0.1) {
    for (let Th_Frag = 0.4; Th_Frag <= 0.8; Th_Frag += 0.2) {
      const res = simulateMetaScheduler(Th_Load, Th_Pri, Th_Frag, 2.0);
      results.push({ Th_Load, Th_Pri, Th_Frag, res });
    }
  }
}

// Sort by Weighted Success + Throughput - Penalty
results.sort((a, b) => {
  const scoreA = a.res.metaThroughput + a.res.metaWeight;
  const scoreB = b.res.metaThroughput + b.res.metaWeight;
  return scoreB - scoreA;
});

const best = results[0]!;
console.log(`\nBest Thresholds found: Load >= ${best.Th_Load.toFixed(2)}, Pri >= ${best.Th_Pri.toFixed(2)}, Frag >= ${best.Th_Frag.toFixed(2)}`);
console.log(`META: Thru ${(best.res.metaThroughput/540).toFixed(4)} | Wgt ${(best.res.metaWeight/540).toFixed(4)} | Miss ${(best.res.metaMiss/540).toFixed(4)} | P95 ${(best.res.metaP95/540).toFixed(1)}`);
console.log("Selection counts:", best.res.selectionCounts);

// Let's specifically analyze Tight Deadlines
console.log("\nAnalyzing Tight Deadlines");
let p10s = data.map((d: any) => d.features.p10DeadlinePressure);
p10s.sort((a: number, b: number) => a - b);
console.log(`Min p10: ${p10s[0]}, P25 p10: ${p10s[Math.floor(p10s.length*0.25)]}, P50: ${p10s[Math.floor(p10s.length*0.5)]}`);

let tThru = { FCFS: 0, PRIORITY: 0, SLACK: 0 };
let tMiss = { FCFS: 0, PRIORITY: 0, SLACK: 0 };
let tP95 = { FCFS: 0, PRIORITY: 0, SLACK: 0 };
let count = 0;
// Use P25 as "Tight"
const tightThreshold = p10s[Math.floor(p10s.length * 0.25)];
for (const exp of data) {
  if (exp.features.p10DeadlinePressure <= tightThreshold) {
    count++;
    for (const p of ['FCFS', 'PRIORITY', 'SLACK'] as const) {
      tThru[p] += exp.outcomes[p].throughput;
      tMiss[p] += exp.outcomes[p].deadlineMisses;
      tP95[p] += exp.outcomes[p].p95Wait;
    }
  }
}
for (const p of ['FCFS', 'PRIORITY', 'SLACK'] as const) {
  console.log(`Tight ${p}: Thru ${(tThru[p]/count).toFixed(4)} | Miss ${(tMiss[p]/count).toFixed(4)} | P95 ${(tP95[p]/count).toFixed(1)}`);
}
