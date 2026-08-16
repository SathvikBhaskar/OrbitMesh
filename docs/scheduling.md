# Scheduling Policies

OrbitMesh implements several deterministic scheduling algorithms. The system acts as a resource broker, assigning tasks to contact windows based on specific objectives.

## FCFS (First-Come, First-Served)
Schedules tasks strictly by their submission deadline (earliest deadline first). Useful for low-contention environments where fairness and throughput are prioritized.

## Priority Scheduler
Sorts tasks by `priority DESC, deadline ASC`. High-value mission tasks preempt lower-priority tasks. Essential under high-pressure contention to maximize weighted success rates.
