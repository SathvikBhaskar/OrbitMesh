# The Meta-Scheduler

The Meta-Scheduler is the core intelligent router of OrbitMesh. Rather than acting as a static policy, it analyzes the incoming workload dynamically at scheduling time and selects the mathematically optimal algorithm.

## Feature Extraction
Before scheduling, the Meta-Scheduler computes:
1. **Load Pressure**: Total task demand vs total usable capacity.
2. **P10 Deadline Pressure**: Median time until the top 10% of imminent tasks expire.
3. **High Priority Fraction**: Proportion of tasks with priority >= 8.
4. **Fragmentation**: The variance and gaps in contact window availability.

## Selection Rules
Based on rigorous evaluation of over 2,160 experimental runs:
- Under **Extreme Contention** or **High Deadline Pressure**, the Meta-Scheduler selects **PRIORITY** to guarantee critical task success.
- Under **Low Contention** and **Low Urgency**, it falls back to **FCFS** to maximize generic throughput and fairness.

## Fail-Closed Execution
If feature extraction fails (e.g., due to corrupt telemetry), the Meta-Scheduler explicitly halts. It operates under a "Fail-Closed" design, preventing unoptimized allocations from bleeding into the production timeline.
