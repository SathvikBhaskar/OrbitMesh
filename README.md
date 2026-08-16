# OrbitMesh

**OrbitMesh is a full-stack research prototype for adaptive satellite-ground-station scheduling. It combines deterministic workload analysis, policy selection, PostgreSQL-backed reservation scheduling, and an interactive React dashboard.**

## Architecture

```text
                USER
                  │
                  ▼
          React Dashboard
                  │
                  ▼
        POST /meta/run
                  │
                  ▼
        Workload Analyzer
                  │
                  ▼
         Policy Selector
             /        \
            /          \
         FCFS        PRIORITY
            \          /
             \        /
              Scheduler
                  │
                  ▼
            Reservations
                  │
          ┌───────┴────────┐
          ▼                ▼
   Reservation        scheduler_runs
     Timeline             Audit
```

## Demo

The interactive dashboard allows you to:
- Generate a 50-task, 40-window reproducible synthetic workload via `POST /api/scheduler/meta/reset`.
- Execute the Meta-Scheduler against the pending workload via `POST /api/scheduler/meta/run`.
- Visualize the timeline of scheduled reservations layered over physical contact windows.
- Inspect the system's reasoning behind its policy selection (FCFS vs. Priority).

## Features

- **Adaptive Meta-Scheduler**: Dynamically extracts mathematical workload features (load pressure, deadline pressure, fragmentation) to select the mathematically optimal scheduling policy.
- **Fail-Closed Architecture**: Built-in transactional safeguards that isolate feature extraction from mission-critical reservation assignments.
- **Predictive Contact Window Generation**: Realistic orbital calculation geometries.
- **Full-Stack Observability**: Detailed metrics on wait times, objective completion, and success rates.

## Tech Stack

- **Frontend**: React, Vite, TypeScript, CSS (Glassmorphism design system).
- **Backend**: Node.js, Express, TypeScript.
- **Database**: PostgreSQL (managed via Drizzle ORM).
- **Deployment**: Fully isolated Docker Compose orchestration.

## How to Run

From a clean environment:

```bash
git clone https://github.com/your-org/orbitmesh.git
cd orbitmesh

# Copy the example environment
cp .env.example .env

# Start the stack
docker compose up -d --build
```

- **Frontend UI:** `http://localhost`
- **Backend API:** `http://localhost:3000`

The system will automatically initialize the database structure. Use the "Reset Demo" button on the UI to seed the initial reproducible workload.

## Scheduler

OrbitMesh utilizes a multi-objective greedy reservation system. While it currently supports strict FCFS and Priority ordering, the true innovation lies in the **Meta-Scheduler** — a lightweight heuristics engine that predicts which underlying strategy will minimize regret against an exhaustive Oracle.

## Experiments & Results

The system was validated using a frozen experimental sandbox (`Scheduler Lab`). 

### Final validation

```text
540 workload configurations
  × 4 policy evaluations (FCFS, Priority, Hybrid Slack, Meta)
-----------------------------------
= 2,160 total policy runs
```

*Note: The Meta-Scheduler's decision space currently contains only `FCFS` and `Priority`. The `Hybrid Slack` policy was included as an experimental baseline for comparison.*

**100% fingerprint reproducibility** was verified across the holdout validation.

**Meta-Scheduler Performance:**

```text
Scheduled:          68.1%
Weighted success:   73.0%
Deadline misses:     0.2%
P95 wait:         14,118 s
```

**Oracle Regret:**

```text
Deadline misses:     0.07%
Throughput:           2.39%
Weighted success:     0.36%
P95 wait:             864 s

Exact Oracle accuracy: 54.1%
```

**Experimental results show a favorable multi-objective tradeoff, but the Meta-Scheduler is not universally optimal.** It provides a workload-aware tradeoff between throughput, deadline reliability, priority-weighted success, and latency.

## Research

The raw experimental results and analysis notebooks mapping the 2,160 evaluations can be found in the `research/` directory. OrbitMesh serves as the empirical foundation for ongoing research into space-network policy orchestration.
