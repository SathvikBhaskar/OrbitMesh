import { calculateFeatures } from '../modules/meta-scheduler/workload-analyzer';
import { Task, ContactWindow } from '../modules/meta-scheduler/types';

function inspect() {
  const refTime = new Date('2026-01-01T10:00:00Z');
  
  // 1. Low Load Workload
  const lowLoadTasks: Task[] = [
    { id: 't1', duration_ms: 100000, priority: 5, deadline: new Date(refTime.getTime() + 1000 * 3600).toISOString() }, // 100s
    { id: 't2', duration_ms: 200000, priority: 5, deadline: new Date(refTime.getTime() + 1000 * 3600).toISOString() }, // 200s
  ];
  // Huge window of 2 hours
  const lowLoadWindows: ContactWindow[] = [
    { id: 'w1', ground_station_id: 's1', aos: new Date(refTime.getTime()).toISOString(), los: new Date(refTime.getTime() + 1000 * 7200).toISOString() }
  ];

  console.log("=== LOW LOAD WORKLOAD ===");
  console.log(calculateFeatures(lowLoadTasks, lowLoadWindows, [], refTime));

  // 2. Highly Fragmented Workload
  // Let's create lots of tiny windows of 50s each, but tasks are 150s. Total capacity is large but fragmented.
  const fragTasks: Task[] = Array.from({ length: 10 }, (_, i) => ({
    id: `t${i}`, duration_ms: 150000, priority: 5, deadline: new Date(refTime.getTime() + 1000 * 3600).toISOString()
  })); // 10 tasks * 150s = 1500s demand

  const fragWindows: ContactWindow[] = [];
  for (let i = 0; i < 40; i++) {
    // 40 windows of 50s each. Total capacity 2000s.
    fragWindows.push({
      id: `w${i}`,
      ground_station_id: 's1',
      aos: new Date(refTime.getTime() + i * 100 * 1000).toISOString(),
      los: new Date(refTime.getTime() + (i * 100 + 50) * 1000).toISOString()
    });
  }

  console.log("\n=== HIGHLY FRAGMENTED WORKLOAD ===");
  console.log(calculateFeatures(fragTasks, fragWindows, [], refTime));
}

inspect();
