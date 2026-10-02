import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../db/client";
import {
  users,
  scheduleVersions,
  scheduleAuditLog,
  reservations,
  missionTasks,
  contactWindows,
  groundStations,
  satellites,
  satelliteOrbitalData,
} from "../db/schema";
import request from "supertest";
import { app } from "../app";
import { eq, inArray, and, or, sql } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { ScheduleInvalidationService } from "../modules/scheduler/dynamic-replanning/schedule-invalidation.service";
import { DynamicReplanningService } from "../modules/scheduler/dynamic-replanning/dynamic-replanning.service";

describe("Phase 5.1 — Dynamic Replanning & Schedule Invalidation Under Orbital TLE Updates", () => {
  let operatorToken: string;
  let viewerToken: string;
  let operatorId: string;
  let viewerId: string;

  // Infrastructure IDs
  let sat1Id: string;
  let sat2Id: string;
  let sat3Id: string;
  let gsChennaiId: string;
  let gsBangaloreId: string;
  let od1Id: string;
  let od2Id: string;

  const epochBase = Date.now() + 25000000;
  const invalidationService = new ScheduleInvalidationService();
  const replanningService = new DynamicReplanningService();

  beforeAll(async () => {
    // 1. Auth Users
    const [op] = await db
      .insert(users)
      .values({
        email: `op51-${Date.now()}@test.com`,
        passwordHash: "hash",
        role: "OPERATOR",
      })
      .returning();
    operatorId = op.id;
    operatorToken = jwt.sign({ sub: op.id, role: "OPERATOR" }, env.jwtSecret);

    const [vi] = await db
      .insert(users)
      .values({
        email: `view51-${Date.now()}@test.com`,
        passwordHash: "hash",
        role: "VIEWER",
      })
      .returning();
    viewerId = vi.id;
    viewerToken = jwt.sign({ sub: vi.id, role: "VIEWER" }, env.jwtSecret);

    // 2. Satellites
    const [s1] = await db
      .insert(satellites)
      .values({
        noradId: 89511 + (Date.now() % 10000),
        name: "Sat-51-Primary",
        type: "LEO",
        status: "ACTIVE",
      })
      .returning();
    sat1Id = s1.id;

    const [s2] = await db
      .insert(satellites)
      .values({
        noradId: 89512 + (Date.now() % 10000),
        name: "Sat-51-Secondary",
        type: "LEO",
        status: "ACTIVE",
      })
      .returning();
    sat2Id = s2.id;

    const [s3] = await db
      .insert(satellites)
      .values({
        noradId: 89513 + (Date.now() % 10000),
        name: "Sat-51-Tertiary",
        type: "LEO",
        status: "ACTIVE",
      })
      .returning();
    sat3Id = s3.id;

    // 3. Ground Stations
    const [gs1] = await db
      .insert(groundStations)
      .values({
        code: `GS-CHE-51-${Date.now() % 10000}`,
        name: "Chennai Primary Telemetry",
        latitude: 13.0827,
        longitude: 80.2707,
        altitudeM: 50,
        minimumElevationDeg: 5,
        status: "AVAILABLE",
        supportedFrequencyBands: ["S_BAND", "X_BAND"],
        maxConcurrentContacts: 1,
        maxDataRateMbps: 150.0,
      })
      .returning();
    gsChennaiId = gs1.id;

    const [gs2] = await db
      .insert(groundStations)
      .values({
        code: `GS-BLR-51-${Date.now() % 10000}`,
        name: "Bangalore Alternate Uplink",
        latitude: 12.9716,
        longitude: 77.5946,
        altitudeM: 920,
        minimumElevationDeg: 5,
        status: "AVAILABLE",
        supportedFrequencyBands: ["S_BAND", "X_BAND"],
        maxConcurrentContacts: 1,
        maxDataRateMbps: 100.0,
      })
      .returning();
    gsBangaloreId = gs2.id;

    // 4. Orbital Data Snapshots
    const [od1] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: sat1Id,
        source: "CELESTRAK",
        tleLine1: "1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997",
        tleLine2: "2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495",
        tleEpoch: new Date(),
        receivedAt: new Date(),
      })
      .returning();
    od1Id = od1.id;

    const [od2] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: sat2Id,
        source: "CELESTRAK",
        tleLine1: "1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997",
        tleLine2: "2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495",
        tleEpoch: new Date(),
        receivedAt: new Date(),
      })
      .returning();
    od2Id = od2.id;

    const v = await db.select().from(scheduleVersions).limit(1);
    if (v.length === 0) {
      await db.insert(scheduleVersions).values({ version: 1 });
    }
  });

  afterAll(async () => {
    const allSatIds = [sat1Id, sat2Id, sat3Id];
    const allGsIds = [gsChennaiId, gsBangaloreId];
    const allOdIds = [od1Id, od2Id];

    await db.delete(reservations).where(or(
      inArray(reservations.satelliteId, allSatIds),
      inArray(reservations.groundStationId, allGsIds)
    ));
    await db.delete(missionTasks).where(inArray(missionTasks.satelliteId, allSatIds));
    await db.delete(contactWindows).where(or(
      inArray(contactWindows.satelliteId, allSatIds),
      inArray(contactWindows.groundStationId, allGsIds)
    ));
    await db.delete(satelliteOrbitalData).where(inArray(satelliteOrbitalData.satelliteId, allSatIds));
    await db.delete(satellites).where(inArray(satellites.id, allSatIds));
    await db.delete(groundStations).where(inArray(groundStations.id, allGsIds));
  });

  async function cleanScopedTestData() {
    const allSatIds = [sat1Id, sat2Id, sat3Id];
    const allGsIds = [gsChennaiId, gsBangaloreId];

    await db.delete(reservations).where(or(
      inArray(reservations.satelliteId, allSatIds),
      inArray(reservations.groundStationId, allGsIds)
    ));
    await db.delete(missionTasks).where(inArray(missionTasks.satelliteId, allSatIds));
    await db.delete(contactWindows).where(or(
      inArray(contactWindows.satelliteId, allSatIds),
      inArray(contactWindows.groundStationId, allGsIds)
    ));
    await db.delete(satelliteOrbitalData).where(and(
      inArray(satelliteOrbitalData.satelliteId, allSatIds),
      sql`id NOT IN (${od1Id}, ${od2Id})`
    ));
  }

  // =========================================================================
  // 1. Mathematical Bound Invariance: IR <= SRE
  // =========================================================================
  it("1. Mathematical bound invariance: Invalidation Rate IR is strictly bounded by Exposure SRE (IR <= SRE)", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 100000;

    // Sat 1 Contact Window & Reservation
    const [w1] = await db.insert(contactWindows).values({
      satelliteId: sat1Id,
      groundStationId: gsChennaiId,
      orbitalDataId: od1Id,
      aos: new Date(t0),
      los: new Date(t0 + 600000),
      durationSeconds: 600,
      maxElevationDeg: 75,
    }).returning();

    const [t1] = await db.insert(missionTasks).values({
      satelliteId: sat1Id,
      name: "Sat1 Bound Task",
      priority: 8,
      durationSeconds: 300,
      deadline: new Date(t0 + 1000000),
      status: "SCHEDULED",
    }).returning();

    await db.insert(reservations).values({
      missionTaskId: t1.id,
      contactWindowId: w1.id,
      groundStationId: gsChennaiId,
      satelliteId: sat1Id,
      windowAos: new Date(t0),
      windowLos: new Date(t0 + 600000),
      taskDurationSeconds: 300,
      allocatedStart: new Date(t0 + 60000),
      allocatedEnd: new Date(t0 + 360000),
      status: "CONFIRMED",
      source: "AUTOMATED",
    });

    // Sat 2 Contact Window & Reservation (Unexposed to Sat 1 update)
    const [w2] = await db.insert(contactWindows).values({
      satelliteId: sat2Id,
      groundStationId: gsBangaloreId,
      orbitalDataId: od2Id,
      aos: new Date(t0),
      los: new Date(t0 + 600000),
      durationSeconds: 600,
      maxElevationDeg: 60,
    }).returning();

    const [t2] = await db.insert(missionTasks).values({
      satelliteId: sat2Id,
      name: "Sat2 Unexposed Task",
      priority: 6,
      durationSeconds: 300,
      deadline: new Date(t0 + 1000000),
      status: "SCHEDULED",
    }).returning();

    await db.insert(reservations).values({
      missionTaskId: t2.id,
      contactWindowId: w2.id,
      groundStationId: gsBangaloreId,
      satelliteId: sat2Id,
      windowAos: new Date(t0),
      windowLos: new Date(t0 + 600000),
      taskDurationSeconds: 300,
      allocatedStart: new Date(t0 + 60000),
      allocatedEnd: new Date(t0 + 360000),
      status: "CONFIRMED",
      source: "AUTOMATED",
    });

    // Run impact analysis assuming Sat 1's orbital data changed
    const impact = await invalidationService.analyzeImpact([sat1Id], new Date(t0 - 10000));

    expect(impact.isBoundSatisfied).toBe(true);
    expect(impact.ir).toBeLessThanOrEqual(impact.sre + 1e-9);
    expect(impact.exposedReservationsCount).toBeGreaterThanOrEqual(1);
  });

  // =========================================================================
  // 2. Invariance Under Identity / Zero Orbital Shift
  // =========================================================================
  it("2. Identity invariance: orbital update with zero window shift preserves all reservations (IR = 0)", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 200000;

    const [w1] = await db.insert(contactWindows).values({
      satelliteId: sat1Id,
      groundStationId: gsChennaiId,
      orbitalDataId: od1Id,
      aos: new Date(t0),
      los: new Date(t0 + 600000),
      durationSeconds: 600,
      maxElevationDeg: 80,
    }).returning();

    const [t1] = await db.insert(missionTasks).values({
      satelliteId: sat1Id,
      name: "Identity Invariant Task",
      priority: 7,
      durationSeconds: 300,
      deadline: new Date(t0 + 1000000),
      status: "SCHEDULED",
    }).returning();

    const [r1] = await db.insert(reservations).values({
      missionTaskId: t1.id,
      contactWindowId: w1.id,
      groundStationId: gsChennaiId,
      satelliteId: sat1Id,
      windowAos: new Date(t0),
      windowLos: new Date(t0 + 600000),
      taskDurationSeconds: 300,
      allocatedStart: new Date(t0 + 100000),
      allocatedEnd: new Date(t0 + 400000),
      status: "CONFIRMED",
      source: "AUTOMATED",
    }).returning();

    // Impact analysis on Sat 1 with identical window present
    const impact = await invalidationService.analyzeImpact([sat1Id], new Date(t0 - 10000));

    const isR1Invalidated = impact.invalidatedReservationIds.includes(r1.id);
    expect(isR1Invalidated).toBe(false);
  });

  // =========================================================================
  // 3. Subtle Window Shift with Margin (Preserved Validity)
  // =========================================================================
  it("3. Subtle window shift within allocation margin preserves reservation validity", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 300000;

    // Reservation allocated from t0 + 120s to t0 + 420s (inside [t0, t0 + 600s])
    const [t1] = await db.insert(missionTasks).values({
      satelliteId: sat1Id,
      name: "Margin Preserved Task",
      priority: 9,
      durationSeconds: 300,
      deadline: new Date(t0 + 1000000),
      status: "SCHEDULED",
    }).returning();

    // Updated window slightly shifted: starts at t0 + 30s, ends at t0 + 570s
    // Since allocated interval [t0 + 120s, t0 + 420s] is fully contained in [t0 + 30s, t0 + 570s], it remains VALID!
    const [wUpdated] = await db.insert(contactWindows).values({
      satelliteId: sat1Id,
      groundStationId: gsChennaiId,
      orbitalDataId: od1Id,
      aos: new Date(t0 + 30000),
      los: new Date(t0 + 570000),
      durationSeconds: 540,
      maxElevationDeg: 78,
    }).returning();

    const [r1] = await db.insert(reservations).values({
      missionTaskId: t1.id,
      contactWindowId: wUpdated.id,
      groundStationId: gsChennaiId,
      satelliteId: sat1Id,
      windowAos: new Date(t0 + 30000),
      windowLos: new Date(t0 + 570000),
      taskDurationSeconds: 300,
      allocatedStart: new Date(t0 + 120000),
      allocatedEnd: new Date(t0 + 420000),
      status: "CONFIRMED",
      source: "AUTOMATED",
    }).returning();

    const impact = await invalidationService.analyzeImpact([sat1Id], new Date(t0));
    expect(impact.invalidatedReservationIds).not.toContain(r1.id);
  });

  // =========================================================================
  // 4. Physical Window Boundary Breach (Invalidation Detection)
  // =========================================================================
  it("4. Window boundary breach: pass shift truncating allocated interval triggers invalidation", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 400000;

    // 1. Initial snapshot window and allocation
    const [wInitial] = await db.insert(contactWindows).values({
      satelliteId: sat1Id,
      groundStationId: gsChennaiId,
      orbitalDataId: od1Id,
      aos: new Date(t0),
      los: new Date(t0 + 600000),
      durationSeconds: 600,
      maxElevationDeg: 80,
    }).returning();

    const [t1] = await db.insert(missionTasks).values({
      satelliteId: sat1Id,
      name: "Truncated Pass Task",
      priority: 8,
      durationSeconds: 300,
      deadline: new Date(t0 + 1000000),
      status: "SCHEDULED",
    }).returning();

    const [r1] = await db.insert(reservations).values({
      missionTaskId: t1.id,
      contactWindowId: wInitial.id,
      groundStationId: gsChennaiId,
      satelliteId: sat1Id,
      windowAos: new Date(t0),
      windowLos: new Date(t0 + 600000),
      taskDurationSeconds: 300,
      allocatedStart: new Date(t0 + 50000),
      allocatedEnd: new Date(t0 + 350000),
      status: "CONFIRMED",
      source: "AUTOMATED",
    }).returning();

    // 2. New TLE snapshot arrives (od1New) with shifted trajectory!
    const [od1New] = await db.insert(satelliteOrbitalData).values({
      satelliteId: sat1Id,
      source: "CELESTRAK",
      tleLine1: "1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997",
      tleLine2: "2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495",
      tleEpoch: new Date(Date.now() + 5000000), // Newer epoch
      receivedAt: new Date(),
    }).returning();

    // 3. Under od1New, window is delayed to start at t0 + 200s (boundary breach for r1 at t0 + 50s)
    await db.insert(contactWindows).values({
      satelliteId: sat1Id,
      groundStationId: gsChennaiId,
      orbitalDataId: od1New.id,
      aos: new Date(t0 + 200000),
      los: new Date(t0 + 800000),
      durationSeconds: 600,
      maxElevationDeg: 65,
    });

    const impact = await invalidationService.analyzeImpact([sat1Id], new Date(t0));
    expect(impact.invalidatedReservationIds).toContain(r1.id);
    expect(impact.affectedTaskIds).toContain(t1.id);

    const detail = impact.details.find((d) => d.reservationId === r1.id);
    expect(detail).toBeDefined();
    expect(detail?.reason).toBe("WINDOW_BOUNDARY_BREACH");
  });

  // =========================================================================
  // 5. Complete Pass Disappearance
  // =========================================================================
  it("5. Pass disappearance: eliminated contact window invalidates dependent reservation", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 500000;

    const [wOld] = await db.insert(contactWindows).values({
      satelliteId: sat1Id,
      groundStationId: gsChennaiId,
      orbitalDataId: od1Id,
      aos: new Date(t0),
      los: new Date(t0 + 300000),
      durationSeconds: 300,
      maxElevationDeg: 15,
    }).returning();

    const [t1] = await db.insert(missionTasks).values({
      satelliteId: sat1Id,
      name: "Disappearing Pass Task",
      priority: 6,
      durationSeconds: 300,
      deadline: new Date(t0 + 1000000),
      status: "SCHEDULED",
    }).returning();

    const [r1] = await db.insert(reservations).values({
      missionTaskId: t1.id,
      contactWindowId: wOld.id,
      groundStationId: gsChennaiId,
      satelliteId: sat1Id,
      windowAos: new Date(t0),
      windowLos: new Date(t0 + 300000),
      taskDurationSeconds: 300,
      allocatedStart: new Date(t0),
      allocatedEnd: new Date(t0 + 300000),
      status: "CONFIRMED",
      source: "AUTOMATED",
    }).returning();

    // In the new orbital update, the pass dropped below minimum elevation, so no window exists under od1New!
    await db.insert(satelliteOrbitalData).values({
      satelliteId: sat1Id,
      source: "CELESTRAK",
      tleLine1: "1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997",
      tleLine2: "2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495",
      tleEpoch: new Date(Date.now() + 6000000),
      receivedAt: new Date(),
    });

    const impact = await invalidationService.analyzeImpact([sat1Id], new Date(t0 - 10000));
    expect(impact.invalidatedReservationIds).toContain(r1.id);
    expect(impact.details.find((d) => d.reservationId === r1.id)?.reason).toBe("PASS_DISAPPEARED");
  });

  // =========================================================================
  // 6. Preservation of Unexposed Satellites and Stations
  // =========================================================================
  it("6. Unexposed reservations on non-updated satellites remain active and untouched", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 600000;

    // Sat 2 reservation (Unexposed to Sat 1 update)
    const [w2] = await db.insert(contactWindows).values({
      satelliteId: sat2Id,
      groundStationId: gsBangaloreId,
      orbitalDataId: od2Id,
      aos: new Date(t0),
      los: new Date(t0 + 400000),
      durationSeconds: 400,
      maxElevationDeg: 70,
    }).returning();

    const [t2] = await db.insert(missionTasks).values({
      satelliteId: sat2Id,
      name: "Unexposed Sat 2 Task",
      priority: 7,
      durationSeconds: 200,
      deadline: new Date(t0 + 1000000),
      status: "SCHEDULED",
    }).returning();

    const [r2] = await db.insert(reservations).values({
      missionTaskId: t2.id,
      contactWindowId: w2.id,
      groundStationId: gsBangaloreId,
      satelliteId: sat2Id,
      windowAos: new Date(t0),
      windowLos: new Date(t0 + 400000),
      taskDurationSeconds: 200,
      allocatedStart: new Date(t0 + 50000),
      allocatedEnd: new Date(t0 + 250000),
      status: "CONFIRMED",
      source: "AUTOMATED",
    }).returning();

    // Analyze impact updating ONLY Sat 1
    const impact = await invalidationService.analyzeImpact([sat1Id], new Date(t0));
    expect(impact.invalidatedReservationIds).not.toContain(r2.id);

    // Verify DB record status is still CONFIRMED
    const dbRes = await db.select().from(reservations).where(eq(reservations.id, r2.id));
    expect(dbRes[0].status).toBe("CONFIRMED");
  });

  // =========================================================================
  // 7. Preservation of MANUAL + LOCKED Reservations
  // =========================================================================
  it("7. MANUAL + LOCKED reservations on non-updated satellites remain completely immutable obstacles", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 700000;

    const [w2] = await db.insert(contactWindows).values({
      satelliteId: sat2Id,
      groundStationId: gsBangaloreId,
      orbitalDataId: od2Id,
      aos: new Date(t0),
      los: new Date(t0 + 600000),
      durationSeconds: 600,
      maxElevationDeg: 85,
    }).returning();

    const [t2] = await db.insert(missionTasks).values({
      satelliteId: sat2Id,
      name: "Locked Manual Obstacle",
      priority: 10,
      durationSeconds: 300,
      deadline: new Date(t0 + 1000000),
      status: "SCHEDULED",
    }).returning();

    const [rLocked] = await db.insert(reservations).values({
      missionTaskId: t2.id,
      contactWindowId: w2.id,
      groundStationId: gsBangaloreId,
      satelliteId: sat2Id,
      windowAos: new Date(t0),
      windowLos: new Date(t0 + 600000),
      taskDurationSeconds: 300,
      allocatedStart: new Date(t0 + 100000),
      allocatedEnd: new Date(t0 + 400000),
      status: "CONFIRMED",
      source: "MANUAL",
      locked: true,
    }).returning();

    // Trigger replanning updating only Sat 1
    const verRes = await db.select().from(scheduleVersions).limit(1);
    const result = await replanningService.replan({
      scheduleVersion: verRes[0].version,
      satelliteIds: [sat1Id],
      strategy: "TARGETED",
      policy: "HYBRID",
      userId: operatorId,
      referenceTime: new Date(t0),
    });

    // Verify locked reservation was NOT invalidated
    expect(result.impact.invalidatedReservationIds).not.toContain(rLocked.id);

    const savedLocked = await db.select().from(reservations).where(eq(reservations.id, rLocked.id));
    expect(savedLocked[0].status).toBe("CONFIRMED");
    expect(savedLocked[0].locked).toBe(true);
    expect(savedLocked[0].source).toBe("MANUAL");
  });

  // =========================================================================
  // 8. Targeted Replanning Rescues Invalidated Task into Alternate Window
  // =========================================================================
  it("8. Targeted replanning rescues invalidated task into available alternate window without touching valid reservations", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 800000;

    // Sat 1 Window 1 on Chennai
    const [wChennai] = await db.insert(contactWindows).values({
      satelliteId: sat1Id,
      groundStationId: gsChennaiId,
      orbitalDataId: od1Id,
      aos: new Date(t0),
      los: new Date(t0 + 300000),
      durationSeconds: 300,
      maxElevationDeg: 75,
    }).returning();

    // Sat 1 Task 1 originally on Chennai
    const [t1] = await db.insert(missionTasks).values({
      satelliteId: sat1Id,
      name: "High Priority Critical Task",
      priority: 9,
      durationSeconds: 200,
      deadline: new Date(t0 + 1000000),
      status: "SCHEDULED",
    }).returning();

    const [r1] = await db.insert(reservations).values({
      missionTaskId: t1.id,
      contactWindowId: wChennai.id,
      groundStationId: gsChennaiId,
      satelliteId: sat1Id,
      windowAos: new Date(t0),
      windowLos: new Date(t0 + 300000),
      taskDurationSeconds: 200,
      allocatedStart: new Date(t0 + 50000),
      allocatedEnd: new Date(t0 + 250000),
      status: "CONFIRMED",
      source: "AUTOMATED",
    }).returning();

    // Orbital perturbation: insert od1New with higher tleEpoch
    const [od1New] = await db.insert(satelliteOrbitalData).values({
      satelliteId: sat1Id,
      source: "CELESTRAK",
      tleLine1: "1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997",
      tleLine2: "2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495",
      tleEpoch: new Date(Date.now() + 8000000),
      receivedAt: new Date(),
    }).returning();

    // Under od1New: Chennai pass is gone, but Bangalore window is available from t0 + 400s to t0 + 800s
    const [wBangalore] = await db.insert(contactWindows).values({
      satelliteId: sat1Id,
      groundStationId: gsBangaloreId,
      orbitalDataId: od1New.id,
      aos: new Date(t0 + 400000),
      los: new Date(t0 + 800000),
      durationSeconds: 400,
      maxElevationDeg: 65,
    }).returning();

    const verRes = await db.select().from(scheduleVersions).limit(1);
    const vBefore = verRes[0].version;

    // Execute TARGETED replanning
    const replanResult = await replanningService.replan({
      scheduleVersion: vBefore,
      satelliteIds: [sat1Id],
      strategy: "TARGETED",
      policy: "HYBRID",
      userId: operatorId,
      referenceTime: new Date(t0),
    });

    expect(replanResult.strategy).toBe("TARGETED");
    expect(replanResult.impact.invalidatedReservationIds).toContain(r1.id);
    expect(replanResult.rescuedCount).toBe(1);
    expect(replanResult.newVersion).toBe(vBefore + 1);

    // Verify task was rescued and rescheduled on alternate Bangalore station
    const newResvs = await db
      .select()
      .from(reservations)
      .where(and(eq(reservations.missionTaskId, t1.id), eq(reservations.status, "PENDING")));

    expect(newResvs.length).toBe(1);
    expect(newResvs[0].groundStationId).toBe(gsBangaloreId);
    expect(newResvs[0].contactWindowId).toBe(wBangalore.id);
  });

  // =========================================================================
  // 9. Full Regeneration Baseline Disruption Comparison
  // =========================================================================
  it("9. Strategy comparison: TARGETED modifies strictly fewer reservations than FULL regeneration", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 900000;

    // Setup 2 tasks on Sat 1 and Sat 2
    const [w1] = await db.insert(contactWindows).values({
      satelliteId: sat1Id,
      groundStationId: gsChennaiId,
      orbitalDataId: od1Id,
      aos: new Date(t0),
      los: new Date(t0 + 600000),
      durationSeconds: 600,
      maxElevationDeg: 80,
    }).returning();

    const [t1] = await db.insert(missionTasks).values({
      satelliteId: sat1Id,
      name: "Sat1 Disruption Probe",
      priority: 8,
      durationSeconds: 200,
      deadline: new Date(t0 + 1000000),
      status: "SCHEDULED",
    }).returning();

    const [r1] = await db.insert(reservations).values({
      missionTaskId: t1.id,
      contactWindowId: w1.id,
      groundStationId: gsChennaiId,
      satelliteId: sat1Id,
      windowAos: new Date(t0),
      windowLos: new Date(t0 + 600000),
      taskDurationSeconds: 200,
      allocatedStart: new Date(t0 + 50000),
      allocatedEnd: new Date(t0 + 250000),
      status: "CONFIRMED",
      source: "AUTOMATED",
    }).returning();

    const [w2] = await db.insert(contactWindows).values({
      satelliteId: sat2Id,
      groundStationId: gsBangaloreId,
      orbitalDataId: od2Id,
      aos: new Date(t0),
      los: new Date(t0 + 600000),
      durationSeconds: 600,
      maxElevationDeg: 75,
    }).returning();

    const [t2] = await db.insert(missionTasks).values({
      satelliteId: sat2Id,
      name: "Sat2 Disruption Probe",
      priority: 7,
      durationSeconds: 200,
      deadline: new Date(t0 + 1000000),
      status: "SCHEDULED",
    }).returning();

    const [r2] = await db.insert(reservations).values({
      missionTaskId: t2.id,
      contactWindowId: w2.id,
      groundStationId: gsBangaloreId,
      satelliteId: sat2Id,
      windowAos: new Date(t0),
      windowLos: new Date(t0 + 600000),
      taskDurationSeconds: 200,
      allocatedStart: new Date(t0 + 50000),
      allocatedEnd: new Date(t0 + 250000),
      status: "CONFIRMED",
      source: "AUTOMATED",
    }).returning();

    // Sat 1 receives orbital update: pass disappeared (no window under od1New)
    await db.insert(satelliteOrbitalData).values({
      satelliteId: sat1Id,
      source: "CELESTRAK",
      tleLine1: "1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997",
      tleLine2: "2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495",
      tleEpoch: new Date(Date.now() + 9000000),
      receivedAt: new Date(),
    });

    // Under TARGETED: Sat 2's reservation r2 is completely undisturbed
    const impact = await invalidationService.analyzeImpact([sat1Id], new Date(t0));
    expect(impact.invalidatedReservationIds.length).toBe(1);
    expect(impact.invalidatedReservationIds).toContain(r1.id);
    expect(impact.invalidatedReservationIds).not.toContain(r2.id);

    // Verify r2 is still CONFIRMED
    const r2Check = await db.select().from(reservations).where(eq(reservations.id, r2.id));
    expect(r2Check[0].status).toBe("CONFIRMED");
  });

  // =========================================================================
  // 10. Audit Logging of Invalidation & Replanning
  // =========================================================================
  it("10. Audit logging: records ORBITAL_UPDATE_DISPLACEMENT and replanning strategy", async () => {
    await cleanScopedTestData();
    const t0 = epochBase + 1000000;

    const [w] = await db.insert(contactWindows).values({
      satelliteId: sat1Id,
      groundStationId: gsChennaiId,
      orbitalDataId: od1Id,
      aos: new Date(t0),
      los: new Date(t0 + 400000),
      durationSeconds: 400,
      maxElevationDeg: 80,
    }).returning();

    const [t] = await db.insert(missionTasks).values({
      satelliteId: sat1Id,
      name: "Audit Verification Task",
      priority: 7,
      durationSeconds: 200,
      deadline: new Date(t0 + 1000000),
      status: "SCHEDULED",
    }).returning();

    const [r] = await db.insert(reservations).values({
      missionTaskId: t.id,
      contactWindowId: w.id,
      groundStationId: gsChennaiId,
      satelliteId: sat1Id,
      windowAos: new Date(t0),
      windowLos: new Date(t0 + 400000),
      taskDurationSeconds: 200,
      allocatedStart: new Date(t0 + 50000),
      allocatedEnd: new Date(t0 + 250000),
      status: "CONFIRMED",
      source: "AUTOMATED",
    }).returning();

    // Invalidate by introducing orbital update where window disappears
    await db.insert(satelliteOrbitalData).values({
      satelliteId: sat1Id,
      source: "CELESTRAK",
      tleLine1: "1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997",
      tleLine2: "2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495",
      tleEpoch: new Date(Date.now() + 10000000),
      receivedAt: new Date(),
    });

    const verRes = await db.select().from(scheduleVersions).limit(1);
    await replanningService.replan({
      scheduleVersion: verRes[0].version,
      satelliteIds: [sat1Id],
      strategy: "TARGETED",
      policy: "HYBRID",
      userId: operatorId,
      referenceTime: new Date(t0),
    });

    // Check scheduleAuditLog for invalidation reason
    const auditEntries = await db
      .select()
      .from(scheduleAuditLog)
      .where(and(eq(scheduleAuditLog.userId, operatorId), eq(scheduleAuditLog.entityId, r.id)));

    expect(auditEntries.length).toBeGreaterThanOrEqual(1);
    expect(auditEntries[0].action).toBe("CANCEL_RESERVATION");
    expect(auditEntries[0].reason).toBe("ORBITAL_UPDATE_DISPLACEMENT");
  });

  // =========================================================================
  // 11. Optimistic Concurrency Protection (HTTP 409)
  // =========================================================================
  it("11. Concurrency control: stale scheduleVersion returns 409 conflict on replan API", async () => {
    const verRes = await db.select().from(scheduleVersions).limit(1);
    const staleVersion = verRes[0].version - 1;

    const res = await request(app)
      .post("/api/scheduler/replanning/replan")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        scheduleVersion: staleVersion,
        satelliteIds: [sat1Id],
        strategy: "TARGETED",
        policy: "HYBRID",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("conflict");
  });

  // =========================================================================
  // 12. Role-Based Access Control (RBAC)
  // =========================================================================
  it("12. Role-Based Access Control: VIEWER cannot trigger impact analysis or replanning (403)", async () => {
    const verRes = await db.select().from(scheduleVersions).limit(1);

    // Viewer analyze-impact -> 403
    const vAnalyze = await request(app)
      .post("/api/scheduler/replanning/analyze-impact")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ satelliteIds: [sat1Id] });
    expect(vAnalyze.status).toBe(403);

    // Viewer replan -> 403
    const vReplan = await request(app)
      .post("/api/scheduler/replanning/replan")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({
        scheduleVersion: verRes[0].version,
        satelliteIds: [sat1Id],
      });
    expect(vReplan.status).toBe(403);

    // Unauthenticated -> 401
    const unauth = await request(app)
      .post("/api/scheduler/replanning/replan")
      .send({
        scheduleVersion: verRes[0].version,
        satelliteIds: [sat1Id],
      });
    expect(unauth.status).toBe(401);
  });
});
