# OrbitMesh — What We Are Actually Building

We are building a **real-data, fault-tolerant, distributed satellite ground-station scheduling platform**.

The important distinction is:

> We are **not** building a satellite tracker, and we are **not** trying to build another SatNOGS.

We are using the satellite/ground-station problem as a realistic environment for solving a harder SDE problem:

> **How do you dynamically allocate scarce resources to competing tasks while maintaining correctness when events arrive concurrently, resources fail, orbital data changes, and priorities change?**

---

## 1. The project in one sentence

**OrbitMesh takes real satellite orbital data, calculates when satellites can communicate with geographically defined ground stations, generates communication opportunities, and dynamically schedules competing mission tasks across those stations while handling conflicts, failures, changing orbital data, concurrency, retries, and rescheduling.**

---

## 2. The real-world scenario

Imagine we have:

### Satellites
```text
SAT-001
SAT-002
SAT-003
...
SAT-100
```
Their orbital data comes from real sources such as CelesTrak.
Each satellite has:
```text
NORAD ID
TLE / OMM
orbit information
```

### Ground stations
We define stations such as:
```text
CHN-01
BLR-01
HYD-01
SIN-01
```
Each has:
```text
latitude
longitude
minimum elevation
supported frequency bands
antenna capability
availability
maximum concurrent contacts
```
The stations are **software/simulation resources**, not physical antennas we control.

---

## 3. First major component: real orbital data

We don't randomly invent:
> SAT-A is visible from Chennai at 10:42.

Instead:
```text
CelesTrak
     ↓
Real orbital elements
     ↓
SGP4 propagation
     ↓
Satellite position over time
```

For example:
```text
SAT-001

10:40 → position X
10:41 → position Y
10:42 → position Z
...
```
We calculate the satellite's position at future timestamps.

---

## 4. Second component: visibility calculation

Now combine:
```text
Satellite position
+
Ground station coordinates
```
and calculate:
```text
azimuth
elevation
range
```
Suppose Chennai requires at least 10° elevation.

We might calculate:
```text
10:40 → 4°   ❌
10:41 → 7°   ❌
10:42 → 13°  ✅
10:43 → 28°  ✅
10:44 → 51°  ✅
10:45 → 43°  ✅
10:46 → 21°  ✅
10:47 → 8°   ❌
```

Therefore:
```text
SAT-001
CHN-01
Contact window:
10:42 → 10:46
```
This is a **real contact opportunity calculated by our system from real orbital data**.

---

## 5. We do this for multiple stations

Suppose:
```text
SAT-001
```
has:
```text
CHN-01
10:42 → 10:46

BLR-01
10:44 → 10:50

HYD-01
11:03 → 11:09
```
We now have a set of candidate communication opportunities.
This becomes the input to the scheduler.

---

## 6. Then comes the actual problem

Suppose missions submit tasks.

```text
Task-101
Satellite: SAT-001
Duration: 4 min
Priority: 8
Deadline: 11:00
Required band: S
```

Another:
```text
Task-102
Satellite: SAT-002
Duration: 5 min
Priority: 10
Deadline: 10:55
Required band: S
```

And another:
```text
Task-103
Satellite: SAT-003
Duration: 3 min
Priority: 4
Deadline: 11:30
```

The scheduler must decide:
> **Which task gets which ground station during which contact window?**

---

## 7. Why this is actually a scheduling problem

Suppose:
```text
CHN-01

SAT-001
10:42 ───────── 10:46

SAT-002
10:44 ───────────── 10:50
```
Both overlap.
But CHN-01 can only handle one communication at a time.
So we can't do:
```text
CHN-01
 ├── SAT-001
 └── SAT-002
```

We need:
```text
Option A

CHN-01 → SAT-001
BLR-01 → SAT-002
```
or:
```text
Option B

CHN-01 → SAT-002
SAT-001 → another opportunity
```
The scheduler evaluates the alternatives.

---

## 8. We won't use only "first available slot"

This is important.
We'll implement multiple scheduling strategies.

### Strategy 1 — FCFS
First task submitted gets priority.
```text
Task A
Task B
Task C

→ A → B → C
```
This becomes our baseline.

### Strategy 2 — Priority scheduling
```text
Task A → priority 5
Task B → priority 10
Task C → priority 3
```
Scheduler prefers:
```text
B → A → C
```

### Strategy 3 — Deadline-aware
A lower-priority task might become more urgent because its deadline is approaching.
```text
Task A
Priority = 5
Deadline = 10:50

Task B
Priority = 10
Deadline = 12:00
```
The scheduler shouldn't blindly choose B.

### Strategy 4 — Hybrid scheduler
Our main scheduler combines:
```text
priority
deadline urgency
mission value
contact quality
station compatibility
reassignment cost
conflict cost
```

Conceptually:
```text
Score =
    priority contribution
  + deadline contribution
  + mission-value contribution
  + contact-quality contribution
  - conflict penalty
  - reassignment penalty
```
We'll benchmark the algorithms rather than claiming ours is mathematically optimal.

---

## 9. Ground-station allocation

This is where the project becomes more than a satellite-pass visualizer.
A task is allocated a resource:
```text
Task-101
    ↓
SAT-001
    ↓
CHN-01
    ↓
10:42:00 – 10:46:00
    ↓
RESERVED
```
The reservation becomes durable in PostgreSQL.

We track:
```text
task
satellite
ground station
start time
end time
status
priority
scheduler decision
```

---

## 10. Multiple scheduler workers

Now we introduce the distributed-systems problem.
Instead of one scheduler:
```text
Scheduler
```
we can run:
```text
Scheduler Worker 1
Scheduler Worker 2
Scheduler Worker 3
```

Why? Because in a production system we want to scale scheduling work horizontally.
But now we have a problem. Two workers might simultaneously see:
```text
CHN-01
10:42 → 10:46
AVAILABLE
```
and both try:
```text
Worker 1 → reserve
Worker 2 → reserve
```
We need concurrency control.

---

## 11. Redis distributed locking

Redis handles short-lived coordination.
Conceptually:
```text
Worker 1
    ↓
acquire lock
    ↓
lock:CHN-01:10:42
    ↓
SUCCESS
```
Worker 2:
```text
acquire lock
    ↓
FAIL
    ↓
re-evaluate
```
But **Redis is not our source of truth**. PostgreSQL remains authoritative. That's an important architectural decision.

---

## 12. PostgreSQL handles durable correctness

PostgreSQL stores the actual state.
For example:
```text
satellites
ground_stations
contact_windows
mission_tasks
reservations
schedule_versions
commands
telemetry
events
failures
```
We'll use transactions and database constraints to prevent invalid reservations.
The principle is:
```text
Redis
   ↓
coordination

PostgreSQL
   ↓
truth
```

---

## 13. Kafka handles events

We also have continuously arriving events.
Examples:
```text
telemetry.received
station.online
station.offline
task.created
task.cancelled
contact.generated
contact.invalidated
schedule.committed
schedule.replanned
command.requested
command.completed
```
Kafka becomes the event backbone.
For example:
```text
Station goes offline
        ↓
Kafka
        ↓
Scheduling consumer
        ↓
Find affected reservations
        ↓
Replan
        ↓
Kafka
        ↓
Dashboard
```

---

## 14. Telemetry is simulated, but realistic

We aren't connecting to a real satellite telemetry transmitter.
Instead we create a satellite simulator.
For example:
```json
{
  "satelliteId": "SAT-001",
  "timestamp": "...",
  "battery": 87.2,
  "temperature": 42.4,
  "signalStrength": -71,
  "latitude": 13.2,
  "longitude": 80.4
}
```
The simulator produces thousands of events.
```text
Satellite Simulator
        ↓
Kafka
        ↓
Telemetry Processor
        ↓
PostgreSQL / Redis
        ↓
Dashboard
```
This gives Kafka a real purpose.

---

## 15. Real-time station state

Redis can maintain fast-changing state:
```text
CHN-01
status = ACTIVE
currentSatellite = SAT-001
signal = -71 dBm
```
The dashboard receives changes through WebSockets.
So the UI can show:
```text
CHN-01    🟢 ACTIVE
BLR-01    🟢 AVAILABLE
HYD-01    🔴 OFFLINE
SIN-01    🟡 RESERVED
```
without refreshing the page.

---

## 16. Dynamic replanning is a core feature

This is one of the most important parts of the project.
Suppose we have:
```text
SAT-A
10:42 → 10:51
Priority 5
```
and:
```text
SAT-B
10:47 → 11:02
Priority 10
```
Our scheduler originally assigns:
```text
CHN-01 → SAT-A
```
Then a new critical task arrives:
```text
SAT-B
Priority = 10
Deadline = 10:55
```
The scheduler doesn't simply say:
> "No slot."

It tries to replan:
```text
New task
   ↓
Find candidate contacts
   ↓
Find conflicts
   ↓
Evaluate existing schedule
   ↓
Search alternate stations
   ↓
Calculate new objective
   ↓
Commit improved schedule
```
Potential result:
```text
CHN-01 → SAT-B

BLR-01 → SAT-A
```
That's **dynamic resource reallocation**.

---

## 17. Ground-station failure

Now imagine:
```text
CHN-01
    ↓
OFFLINE
```
There are existing reservations:
```text
SAT-A → CHN-01
SAT-B → CHN-01
SAT-C → CHN-01
```
Our system identifies affected reservations.
```text
CHN-01 OFFLINE
       ↓
Kafka event
       ↓
Find affected schedules
       ↓
Recalculate alternatives
       ↓
BLR-01 / HYD-01 / SIN-01
       ↓
Reassign feasible tasks
```
Tasks that cannot be rescued are explicitly marked: `UNSCHEDULABLE` with an explanation.

---

## 18. Orbital-data changes

Suppose the old orbital data produced:
```text
SAT-A
10:42 → 10:51
```
New orbital data produces:
```text
SAT-A
10:44 → 10:53
```
Our system detects:
```text
orbital data updated
       ↓
recalculate affected windows
       ↓
compare against reservations
       ↓
invalidate affected reservations
       ↓
replan
```
So our schedule isn't static.

---

## 19. Failure handling

We deliberately test failures. For example:
- Kafka consumer crashes
- PostgreSQL temporarily unavailable
- Scheduler worker crashes
- Ground station goes offline
- Duplicate Kafka event arrives

The system needs: `retry`, `idempotency`, `dead-letter queue`, `recovery`, `replanning`.

---

## 20. Idempotency

Suppose Kafka delivers:
```text
task.created
task.created
task.created
```
because consumers can receive duplicate events.
We must end up with `ONE task`, not `THREE tasks`.
Similarly, scheduling `task-123` twice mustn't create two reservations. We'll enforce this at both application and database levels.

---

## 21. Scheduler Laboratory

Instead of only having a `Dashboard`, we have a `Scheduler Lab`.
The user configures:
```text
Satellites:       100
Stations:          20
Tasks:           10,000
Telemetry rate:  5,000/sec
Failure rate:        5%
```
Then `RUN SIMULATION`. The system generates a controlled workload.

---

## 22. We compare scheduling algorithms

Example output:
```text
                  FCFS    PRIORITY    HYBRID

Tasks scheduled    X         X          X
Deadline success   X%        X%         X%
Station utilization X%       X%         X%
P95 latency        X ms      X ms       X ms
Replans             X         X          X
Failed tasks        X         X          X
```
We don't invent these values. We'll actually run the system and measure them.

---

## 23. Failure-injection laboratory

The Scheduler Lab can also introduce failures:
- `[Kill Scheduler Worker]`
- `[Take CHN-01 Offline]`
- `[Inject Duplicate Kafka Event]`
- `[Delay Telemetry]`
- `[Change Orbital Data]`
- `[Simulate DB Failure]`

Then we measure: Recovery time, Tasks lost, Duplicate schedules, Replanning time, System availability.

---

## 24. Explainable scheduling

Every decision should be explainable.
Suppose `SAT-A → CHN-01`. The UI can show:
```text
WHY THIS CONTACT?

Priority              9.0
Deadline urgency      8.4
Mission value         9.1
Contact quality       8.0
Station capability   10.0
Conflict penalty     -0.0
Reassignment cost    -1.0

Final score            8.7
```
If rejected:
```text
TASK-1928 REJECTED

CHN-01: ✗ conflicting reservation
BLR-01: ✗ insufficient elevation
HYD-01: ✗ incompatible frequency
SIN-01: ✗ deadline impossible
```

---

## 25. What the user sees

The dashboard has roughly four major areas:
1. **Mission Control**: Active satellites/stations, Current contacts, Telemetry, Alerts.
2. **Schedule Timeline**: Gantt chart style visualization of ground station usage over time.
3. **Scheduler Lab**: Configure workload, failures, algorithms and compare results.
4. **System Health**: Kafka Lag, Redis Locks, PostgreSQL Connections, Scheduler Latency, Stations online/offline.

---

## 26. What is real vs simulated?

| Component                   | Real?                                |
| --------------------------- | ------------------------------------ |
| Satellite orbital data      | **Yes**                              |
| TLE/OMM                     | **Yes**                              |
| Satellite propagation       | **Yes**                              |
| Satellite position          | **Calculated from real data**        |
| Visibility/contact windows  | **Calculated by us**                 |
| Ground-station coordinates  | **Realistic/real locations**         |
| Ground-station resources    | **Simulated**                        |
| Telemetry                   | **Simulated**                        |
| Mission tasks               | **Simulated/user-generated**         |
| Scheduling                  | **Actually performed by our system** |
| Ground-station reservation  | **Our software reservation**         |
| RF communication            | **No**                               |
| Satellite command execution | **Simulated**                        |

---

## 27. Complete data flow

```text
                   REAL ORBITAL DATA
                         │
                         ▼
                    CelesTrak
                         │
                         ▼
                 Orbital Data Service
                         │
                         ▼
                       Kafka
                         │
                         ▼
                  SGP4 Propagation
                         │
                         ▼
                Visibility Calculator
                         │
                         ▼
                  Contact Windows
                         │
                         ▼
              ┌─────────────────────┐
              │ Scheduling Engine   │
              │                     │
              │ Constraints         │
              │ Candidate Selection │
              │ Scoring             │
              │ Conflict Resolution │
              │ Replanning          │
              └──────────┬──────────┘
                         │
                 ┌───────┴────────┐
                 ▼                ▼
              Redis           PostgreSQL
              locks            source of truth
                 │                │
                 └───────┬────────┘
                         │
                         ▼
                 Schedule Events
                         │
                         ▼
                       Kafka
                         │
             ┌───────────┼───────────┐
             ▼           ▼           ▼
        Dashboard    Analytics    Notifications
```

Separately:
```text
Satellite Simulator
        │
        ▼
      Kafka
        │
        ▼
Telemetry Processor
        │
        ├── PostgreSQL
        └── Redis
```

---

## 28. Technology stack — final

- **Frontend**: React, TypeScript, WebSocket, Leaflet / map visualization
- **Backend**: Node.js, TypeScript, REST APIs, WebSockets
- **Core computation**: SGP4, Astronomical/geospatial calculations, Scheduling algorithms
- **Persistence**: PostgreSQL
- **Distributed systems**: Apache Kafka, Redis
- **Infrastructure**: Docker, Docker Compose
- **Observability**: Prometheus, Grafana, structured logging
- **Testing**: unit tests, integration tests, load tests, failure injection
- **NOT using**: Kubernetes, MongoDB, Elasticsearch, service mesh, API gateway, ML.

---

## 29. What makes this an SDE project rather than a satellite project?

The satellite domain gives us the constraints. The actual SDE problems are:
- Concurrency Control (Distributed locking)
- Reliability (Retry/DLQ, Idempotency)
- Scalability (Kafka, Workers)
- Algorithmic Complexity (Constraints, Replanning)

---

## 30. The final objective

> **Here are 100 real satellites and 20 geographically distributed ground stations. The system retrieves current orbital data, calculates contact opportunities, receives thousands of mission tasks, allocates stations according to priority/deadline/capability constraints, processes telemetry through Kafka, coordinates concurrent scheduler workers using Redis, persists authoritative reservations in PostgreSQL, automatically replans when stations fail or orbital data changes, and measures how different scheduling algorithms perform under load and failure.**

---

## 31. What the final demo should look like

A strong 5-minute demo would be:
1. Select real satellites (ISS, NOAA, Starlink).
2. Show their real calculated visibility over Chennai/Bangalore/Hyderabad.
3. Generate 1,000 mission tasks.
4. Run the scheduler.
5. Show station allocations.
6. Take Chennai station offline.
7. Watch the scheduler detect affected reservations and replan.
8. Inject duplicate Kafka events.
9. Show that idempotency prevents duplicate scheduling.
10. Run the same workload using FCFS vs Priority vs Hybrid and compare results.

---

## 32. Our development order

We should **not** start with Kafka. The implementation order should be:

1. **PHASE 1**: Domain model, PostgreSQL schema, Ground stations, Satellites, Mission tasks
2. **PHASE 2**: Real orbital data, TLE/OMM, SGP4, Visibility calculation, Contact windows
3. **PHASE 3**: Basic scheduler, FCFS, Priority, Conflict detection, Reservations
4. **PHASE 4**: Hybrid scheduler, Deadline handling, Station capabilities, Multi-station allocation
5. **PHASE 5**: Dynamic replanning, Station failures, Orbital-data changes
6. **PHASE 6**: Kafka, Telemetry pipeline, Scheduling events, Retries, DLQ
7. **PHASE 7**: Redis, Distributed locking, Caching, Ephemeral station state
8. **PHASE 8**: Multiple scheduler workers, Concurrency testing, Idempotency, Recovery
9. **PHASE 9**: React dashboard, WebSockets, Maps, Timeline
10. **PHASE 10**: Scheduler Lab, Failure injection, Load testing, Algorithm comparison
11. **PHASE 11**: Prometheus, Grafana, Docker, Production hardening
