# Database Schema

The OrbitMesh database strictly enforces scheduling invariants at the database level.

### Key Tables

- **`satellites`**: Physical space assets.
- **`ground_stations`**: Earth-based receiving nodes.
- **`contact_windows`**: Temporally bounded overlapping visibility periods between a satellite and station.
- **`mission_tasks`**: Desired telemetry/command operations requested by users.
- **`reservations`**: Immutable assignments mapping a `mission_task` to a portion of a `contact_window`.
- **`scheduler_runs`**: Telemetry and audit logs for the Meta-Scheduler execution.

### Invariants
The system relies on Postgres unique indexes to guarantee safety under concurrent execution:
- A single task cannot be scheduled twice.
- A single contact window cannot be double-booked (handled transactionally in the application logic).
