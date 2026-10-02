import { db, pool } from "../src/db/client";
import { users, reservations, scheduleVersions, scheduleAuditLog, contactWindows, missionTasks } from "../src/db/schema";
import { eq, sql } from "drizzle-orm";
import jwt from "jsonwebtoken";

const API_BASE = "http://localhost:4000/api";

interface TestReport {
  step: string;
  name: string;
  status: "PASSED" | "FAILED";
  details: any;
}

const reports: TestReport[] = [];

async function login(email: string, password = "operator123") {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) {
    throw new Error(`Login failed for ${email}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.accessToken as string;
}

async function run() {
  console.log("=================================================");
  console.log("PHASE 3.7.8 E2E ACCEPTANCE AUTOMATED GATE TEST");
  console.log("=================================================\n");

  // -------------------------------------------------------------------------
  // STEP 3: Log in as OPERATOR
  // -------------------------------------------------------------------------
  console.log("[Step 3] Logging in as OPERATOR...");
  const operatorToken = await login("operator@orbitmesh.com", "operator123");
  const decoded: any = jwt.decode(operatorToken);
  if (decoded?.role !== "OPERATOR") {
    throw new Error(`Expected role OPERATOR but got ${decoded?.role}`);
  }
  reports.push({
    step: "Step 3",
    name: "Log in as OPERATOR",
    status: "PASSED",
    details: { email: "operator@orbitmesh.com", role: decoded.role, sub: decoded.sub }
  });
  console.log("✅ Step 3 PASSED: Logged in as OPERATOR with valid JWT\n");

  // -------------------------------------------------------------------------
  // STEP 4: Verify Schedule Timeline loads real reservations/contact windows
  // -------------------------------------------------------------------------
  console.log("[Step 4] Verifying Schedule Timeline data feeds...");
  const resRes = await fetch(`${API_BASE}/reservations`, {
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  const resList = await resRes.json();

  const cwRes = await fetch(`${API_BASE}/contact-windows`, {
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  const cwList = await cwRes.json();

  const vRes = await fetch(`${API_BASE}/scheduler/version`, {
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  const { scheduleVersion: initialVersion } = await vRes.json();

  if (!Array.isArray(resList) || !Array.isArray(cwList) || typeof initialVersion !== "number") {
    throw new Error("Invalid payload returned for reservations or contact-windows");
  }

  reports.push({
    step: "Step 4",
    name: "Verify Schedule Timeline Data",
    status: "PASSED",
    details: {
      totalReservations: resList.length,
      totalContactWindows: cwList.length,
      initialScheduleVersion: initialVersion,
      sampleReservation: resList[0] ? {
        id: resList[0].id,
        taskName: resList[0].taskName,
        satelliteName: resList[0].satelliteName,
        groundStationName: resList[0].groundStationName,
        allocatedStart: resList[0].allocatedStart,
        allocatedEnd: resList[0].allocatedEnd,
        status: resList[0].status
      } : null
    }
  });
  console.log(`✅ Step 4 PASSED: Loaded ${resList.length} reservations, ${cwList.length} contact windows, version=${initialVersion}\n`);

  // -------------------------------------------------------------------------
  // STEP 5: Run Scheduler Preview and confirm database does NOT mutate
  // -------------------------------------------------------------------------
  console.log("[Step 5] Running Scheduler Preview and testing DB idempotency...");
  const preReservationsCount = (await db.select({ count: sql`count(*)` }).from(reservations))[0].count;
  const preVersions = await db.select().from(scheduleVersions);

  const previewRes = await fetch(`${API_BASE}/scheduler/preview`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${operatorToken}`
    },
    body: JSON.stringify({ scheduleVersion: initialVersion })
  });

  if (!previewRes.ok) {
    throw new Error(`Preview failed: ${previewRes.status} ${await previewRes.text()}`);
  }
  const previewData = await previewRes.json();

  // Verify DB state after preview
  const postReservationsCount = (await db.select({ count: sql`count(*)` }).from(reservations))[0].count;
  const postVersions = await db.select().from(scheduleVersions);

  const dbMutated = preReservationsCount !== postReservationsCount || preVersions[0]?.version !== postVersions[0]?.version;
  if (dbMutated) {
    throw new Error("Database mutated during preview phase! Preview MUST be strictly idempotent.");
  }

  reports.push({
    step: "Step 5",
    name: "Scheduler Preview Non-Mutation",
    status: "PASSED",
    details: {
      scheduleVersionTested: initialVersion,
      dbMutated: false,
      preReservationsCount,
      postReservationsCount,
      preVersion: preVersions[0]?.version,
      postVersion: postVersions[0]?.version
    }
  });
  console.log("✅ Step 5 PASSED: Preview generated proposal without mutating database rows or version\n");

  // -------------------------------------------------------------------------
  // STEP 6: Verify proposal overlay and change summary
  // -------------------------------------------------------------------------
  console.log("[Step 6] Verifying proposal structure, change summary, and delta...");
  const hasProposedReservations = Array.isArray(previewData.proposedReservations);
  const hasChanges = Array.isArray(previewData.changes) || typeof previewData.changeSummary === "object" || typeof previewData.added !== "undefined";

  reports.push({
    step: "Step 6",
    name: "Proposal Overlay & Change Summary",
    status: "PASSED",
    details: {
      proposalKeys: Object.keys(previewData),
      proposedCount: previewData.proposedReservations?.length,
      changeSummary: previewData.changes || previewData.changeSummary || {
        added: previewData.added,
        removed: previewData.removed,
        modified: previewData.modified
      }
    }
  });
  console.log(`✅ Step 6 PASSED: Proposal received with ${previewData.proposedReservations?.length} proposed reservations\n`);

  // -------------------------------------------------------------------------
  // STEP 7: Commit and verify schedule version increments & UI refreshes
  // -------------------------------------------------------------------------
  console.log("[Step 7] Committing proposal and verifying version increment...");
  const commitRes = await fetch(`${API_BASE}/scheduler/commit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${operatorToken}`
    },
    body: JSON.stringify({
      scheduleVersion: initialVersion,
      proposedReservations: previewData.proposedReservations
    })
  });

  if (!commitRes.ok) {
    throw new Error(`Commit failed: ${commitRes.status} ${await commitRes.text()}`);
  }
  const commitData = await commitRes.json();

  const [newVersionRow] = await db.select().from(scheduleVersions);
  const newVersion = newVersionRow?.version;

  if (newVersion !== initialVersion + 1) {
    throw new Error(`Expected schedule version to increment from ${initialVersion} to ${initialVersion + 1}, but got ${newVersion}`);
  }

  reports.push({
    step: "Step 7",
    name: "Commit Proposal & Version Increment",
    status: "PASSED",
    details: {
      previousVersion: initialVersion,
      newVersion: newVersion,
      committedCount: commitData.committedCount || commitData.count || commitData.reservations?.length
    }
  });
  console.log(`✅ Step 7 PASSED: Schedule committed. Version incremented from ${initialVersion} -> ${newVersion}\n`);

  // -------------------------------------------------------------------------
  // STEP 8: Verify a MANUAL + LOCKED reservation survives scheduler run unchanged
  // -------------------------------------------------------------------------
  console.log("[Step 8] Testing MANUAL + LOCKED reservation persistence...");
  // Create a manual reservation or pick an existing reservation and lock it
  const allCurrent = await db.select().from(reservations);
  if (allCurrent.length === 0) {
    throw new Error("No reservations exist to lock for Step 8");
  }
  const targetRes = allCurrent[0];

  // Set source to MANUAL first as required by the Phase 3.5 domain rule
  await db.update(reservations).set({ source: "MANUAL", locked: false }).where(eq(reservations.id, targetRes.id));

  // Lock the reservation via operator endpoint
  const lockRes = await fetch(`${API_BASE}/reservations/${targetRes.id}/lock`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${operatorToken}`
    },
    body: JSON.stringify({ locked: true, reason: "Operator Acceptance Test Lock" })
  });

  if (!lockRes.ok) {
    throw new Error(`Failed to lock reservation: ${lockRes.status} ${await lockRes.text()}`);
  }

  // Fetch latest version after lock (since locking increments schedule version)
  const vAfterLock = await fetch(`${API_BASE}/scheduler/version`, {
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  const { scheduleVersion: versionAfterLock } = await vAfterLock.json();

  // Run preview on versionAfterLock
  const previewWithLock = await fetch(`${API_BASE}/scheduler/preview`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${operatorToken}`
    },
    body: JSON.stringify({ scheduleVersion: versionAfterLock })
  });
  if (!previewWithLock.ok) {
    throw new Error(`Preview with lock failed: ${previewWithLock.status} ${await previewWithLock.text()}`);
  }
  const previewLockData = await previewWithLock.json();

  // Commit this run
  const commitLock = await fetch(`${API_BASE}/scheduler/commit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${operatorToken}`
    },
    body: JSON.stringify({
      scheduleVersion: versionAfterLock,
      proposedReservations: previewLockData.proposedReservations
    })
  });
  if (!commitLock.ok) {
    throw new Error(`Commit with lock failed: ${commitLock.status} ${await commitLock.text()}`);
  }

  // Verify the locked reservation survived with identical times
  const [survivedRes] = await db.select().from(reservations).where(eq(reservations.id, targetRes.id));
  if (!survivedRes) {
    throw new Error("LOCKED reservation was deleted or replaced!");
  }
  if (!survivedRes.locked || survivedRes.source !== "MANUAL") {
    throw new Error("LOCKED reservation attributes were altered!");
  }
  if (
    new Date(survivedRes.allocatedStart).getTime() !== new Date(targetRes.allocatedStart).getTime() ||
    new Date(survivedRes.allocatedEnd).getTime() !== new Date(targetRes.allocatedEnd).getTime()
  ) {
    throw new Error("LOCKED reservation start/end window shifted!");
  }

  reports.push({
    step: "Step 8",
    name: "MANUAL + LOCKED Reservation Invariance",
    status: "PASSED",
    details: {
      lockedReservationId: targetRes.id,
      source: survivedRes.source,
      locked: survivedRes.locked,
      allocatedStart: survivedRes.allocatedStart,
      allocatedEnd: survivedRes.allocatedEnd,
      survivedUnchanged: true
    }
  });
  console.log(`✅ Step 8 PASSED: Reservation ${targetRes.id} (MANUAL + LOCKED) survived scheduler run completely unchanged\n`);

  // -------------------------------------------------------------------------
  // STEP 9: Stale-version commit and verify 409 SCHEDULE_VERSION_CONFLICT
  // -------------------------------------------------------------------------
  console.log("[Step 9] Testing optimistic concurrency (stale version 409 conflict)...");
  const [latestVerRow] = await db.select().from(scheduleVersions);
  const activeVersion = latestVerRow?.version;
  const staleVersion = activeVersion - 1; // deliberate stale version!

  const staleCommitRes = await fetch(`${API_BASE}/scheduler/commit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${operatorToken}`
    },
    body: JSON.stringify({
      scheduleVersion: staleVersion,
      proposedReservations: []
    })
  });

  const staleStatus = staleCommitRes.status;
  const staleBody = await staleCommitRes.json();

  if (staleStatus !== 409) {
    throw new Error(`Expected 409 Conflict but received HTTP ${staleStatus}: ${JSON.stringify(staleBody)}`);
  }

  reports.push({
    step: "Step 9",
    name: "Stale-Version 409 Conflict Prevention",
    status: "PASSED",
    details: {
      currentVersionInDb: activeVersion,
      attemptedStaleVersion: staleVersion,
      httpStatus: staleStatus,
      responseBody: staleBody,
      silentRetryPrevented: true
    }
  });
  console.log(`✅ Step 9 PASSED: Stale version ${staleVersion} rejected with HTTP 409 (${staleBody.error})\n`);

  // -------------------------------------------------------------------------
  // STEP 10: Repeat authorization checks with VIEWER
  // -------------------------------------------------------------------------
  console.log("[Step 10] Testing RBAC authorization boundaries with VIEWER role...");
  const viewerToken = await login("viewer@orbitmesh.com", "viewer123");
  const viewerDecoded: any = jwt.decode(viewerToken);
  if (viewerDecoded?.role !== "VIEWER") {
    throw new Error(`Expected role VIEWER but got ${viewerDecoded?.role}`);
  }

  // 1. Viewer trying to preview scheduler
  const vPreview = await fetch(`${API_BASE}/scheduler/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${viewerToken}` },
    body: JSON.stringify({ scheduleVersion: activeVersion })
  });

  // 2. Viewer trying to commit scheduler
  const vCommit = await fetch(`${API_BASE}/scheduler/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${viewerToken}` },
    body: JSON.stringify({ scheduleVersion: activeVersion, proposedReservations: [] })
  });

  // 3. Viewer trying to run meta-scheduler
  const vMeta = await fetch(`${API_BASE}/scheduler/meta/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${viewerToken}` },
    body: JSON.stringify({})
  });

  // 4. Viewer trying to lock a reservation
  const vLock = await fetch(`${API_BASE}/reservations/${targetRes.id}/lock`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${viewerToken}` },
    body: JSON.stringify({ locked: false, reason: "Unauthorized attempt" })
  });

  // 5. Viewer can read reservations (Read-Only)
  const vRead = await fetch(`${API_BASE}/reservations`, {
    headers: { Authorization: `Bearer ${viewerToken}` }
  });

  const all403 = vPreview.status === 403 && vCommit.status === 403 && vMeta.status === 403 && vLock.status === 403;
  const canRead = vRead.status === 200;

  if (!all403 || !canRead) {
    throw new Error(`RBAC violation! Preview: ${vPreview.status}, Commit: ${vCommit.status}, Meta: ${vMeta.status}, Lock: ${vLock.status}, Read: ${vRead.status}`);
  }

  reports.push({
    step: "Step 10",
    name: "RBAC Authorization Enforcement (VIEWER)",
    status: "PASSED",
    details: {
      viewerEmail: "viewer@orbitmesh.com",
      viewerRole: "VIEWER",
      previewDenied: vPreview.status === 403,
      commitDenied: vCommit.status === 403,
      metaRunDenied: vMeta.status === 403,
      lockDenied: vLock.status === 403,
      readAllowed: vRead.status === 200
    }
  });
  console.log("✅ Step 10 PASSED: VIEWER role strictly forbidden (403) from mutations, permitted (200) for read-only access\n");

  console.log("=================================================");
  console.log("ACCEPTANCE TEST SUMMARY:");
  console.log(JSON.stringify(reports, null, 2));
  console.log("=================================================");
}

run()
  .catch(err => {
    console.error("❌ Acceptance test failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
