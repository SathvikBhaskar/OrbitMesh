# System Architecture

OrbitMesh uses a decoupled Node.js/Express backend, a Vite/React frontend, and a PostgreSQL relational database.

## Separation of Concerns

1. **API Layer (`src/app.ts`, `src/modules/*/router.ts`)**
   Handles HTTP transit, input validation, and CORS. The frontend communicates exclusively through these boundaries and contains no scheduling logic.
   
2. **Scheduling Engine (`src/modules/scheduler`)**
   Implements domain-specific heuristics (FCFS, Priority) leveraging the `CandidateService` to match tasks against orbital contact windows.
   
3. **Meta-Scheduler (`src/modules/meta-scheduler`)**
   A layer sitting above the schedulers. Extracts temporal features (deadline pressure, load factor) and uses defined heuristics to route workloads.
   
4. **Data Access (`src/db/`)**
   Uses Drizzle ORM to enforce strict schema shapes and transactional guarantees during reservation allocation.
