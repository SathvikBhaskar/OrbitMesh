# Issues and Architecture Log

This document tracks all compiler issues, logical errors, architectural challenges, and test failures encountered during the development of OrbitMesh. 

**Core Principles:**
1. **Absolute Transparency**: All issues are logged here exactly as they occur.
2. **No Hallucination**: Test results and system behaviors are reported genuinely.
3. **Verified Claims Only**: The system is only claimed to be robust if proven by load tests and failure injection.
4. **Accepting Failure**: It is okay for tests to fail; failures are documented and analyzed here rather than hidden.

## Open Issues
*(No open issues currently.)*

## Resolved Issues
- **Docker Daemon Down**: The Docker daemon was not running during Phase 1 testing. The user started Docker Desktop, and the issue was resolved.
- **Docker Daemon Down (Phase 2)**: The server restarted and Docker daemon stopped again. Asked the user to restart Docker Desktop before continuing migrations.
- **TS5108 (moduleResolution)**: TypeScript 5.7 removed the `moduleResolution: "Node"` option. This was replaced with `"Node16"` in `tsconfig.json`.
- **Port Conflict on 3000**: During Step 2 verification, `Invoke-RestMethod http://localhost:3000/health` unexpectedly returned `{"status":"healthy","activeSessions":0}` from another application running on the host. The Express app port was changed to `4000` in `.env` to avoid this collision.
- **DATABASE_URL Not Set**: In Step 2, I failed to include `DATABASE_URL` in `.env`, which caused `drizzle-kit` to fail in Step 3. This was a logical error on my part. I have updated the `.env` files to resolve this.
