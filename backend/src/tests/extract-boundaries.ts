import fs from 'fs';
import path from 'path';
import { WorkloadConfig } from '../modules/scheduler-lab/types';
import { WorkloadGenerator } from '../modules/scheduler-lab/workload-generator';
import { calculateFeatures } from '../modules/meta-scheduler/workload-analyzer';
import { Task, ContactWindow } from '../modules/meta-scheduler/types';

const csvPath = path.join(__dirname, '../../results/campaign-2026-08-15.csv');

function parseCSV(filePath: string) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim() !== '');
  const headers = lines[0]!.split(',');
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i]!.split(',');
    const obj: any = {};
    headers.forEach((h, idx) => {
      obj[h] = values[idx];
    });
    records.push(obj);
  }
  return records;
}

function analyze() {
  const records = parseCSV(csvPath);
  
  // Group by experiment_id
  const experiments = new Map<string, any>();
  for (const r of records) {
    if (!experiments.has(r.experiment_id)) {
      experiments.set(r.experiment_id, {
        config: {
          seed: r.seed,
          taskCount: parseInt(r.task_count),
          deadlineRegime: r.deadline_regime,
          priorityDistribution: r.priority_distribution,
          durationDistribution: r.duration_distribution
        },
        runs: []
      });
    }
    experiments.get(r.experiment_id).runs.push(r);
  }

  const results: any[] = [];

  const refTime = new Date("2026-08-16T00:00:00Z");

  for (const [expId, data] of experiments.entries()) {
    const wConfig: WorkloadConfig = {
      seed: data.config.seed,
      referenceTime: refTime,
      taskCount: data.config.taskCount,
      satelliteCount: 5,
      stationCount: 2,
      deadlineRegime: data.config.deadlineRegime,
      priorityDistribution: data.config.priorityDistribution,
      durationDistribution: data.config.durationDistribution,
      arrivalSpreadSeconds: 86400
    };

    const wg = new WorkloadGenerator(wConfig);
    const wl = wg.generate();
    
    // Convert to compatible types
    const tasks: Task[] = wl.tasks.map(t => ({
      id: t.id,
      priority: t.priority,
      duration_ms: t.durationSeconds * 1000,
      deadline: t.deadline
    }));
    const windows: ContactWindow[] = wl.windows.map(w => ({
      id: w.id,
      ground_station_id: w.groundStationId,
      aos: w.aos,
      los: w.los
    }));

    const features = calculateFeatures(tasks, windows, [], refTime);

    // Extract policy outcomes
    const fcfs = data.runs.find((r: any) => r.policy === 'FCFS');
    const priority = data.runs.find((r: any) => r.policy === 'PRIORITY');
    const slack = data.runs.find((r: any) => r.policy === 'HYBRID_SLACK');

    if (!fcfs || !priority || !slack) continue;

    results.push({
      expId,
      features,
      outcomes: {
        FCFS: {
          throughput: parseFloat(fcfs.success_rate),
          weightedSuccess: parseFloat(fcfs.priority_weighted_success),
          deadlineMisses: parseFloat(fcfs.deadline_miss_rate),
          p95Wait: parseFloat(fcfs.p95_wait_ms)
        },
        PRIORITY: {
          throughput: parseFloat(priority.success_rate),
          weightedSuccess: parseFloat(priority.priority_weighted_success),
          deadlineMisses: parseFloat(priority.deadline_miss_rate),
          p95Wait: parseFloat(priority.p95_wait_ms)
        },
        SLACK: {
          throughput: parseFloat(slack.success_rate),
          weightedSuccess: parseFloat(slack.priority_weighted_success),
          deadlineMisses: parseFloat(slack.deadline_miss_rate),
          p95Wait: parseFloat(slack.p95_wait_ms)
        }
      }
    });
  }

  // Write out combined data
  fs.writeFileSync(path.join(__dirname, 'combined-features.json'), JSON.stringify(results, null, 2));
  console.log(`Extracted features and outcomes for ${results.length} experiments.`);
}

analyze();
