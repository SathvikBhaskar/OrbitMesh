import {
  pgTable,
  uuid,
  integer,
  varchar,
  text,
  doublePrecision,
  timestamp,
  pgEnum,
  check,
  index,
  unique,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const orbitalDataSourceEnum = pgEnum("orbital_data_source", ["CELESTRAK"]);

export const satelliteStatusEnum = pgEnum("satellite_status", ["ACTIVE", "INACTIVE"]);
export const groundStationStatusEnum = pgEnum("ground_station_status", [
  "AVAILABLE",
  "OFFLINE",
  "MAINTENANCE",
]);
export const missionTaskStatusEnum = pgEnum("mission_task_status", [
  "PENDING",
  "SCHEDULED",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
]);

export const runTypeEnum = pgEnum("run_type", ["PRODUCTION", "LAB"]);
export const executionStatusEnum = pgEnum("execution_status", [
  "SUCCESS",
  "FAILED_FEATURE_EXTRACTION",
  "FAILED_EXECUTION",
  "PARTIAL",
]);

export const satellites = pgTable(
  "satellites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noradId: integer("norad_id").notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    status: satelliteStatusEnum("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    noradIdCheck: check("norad_id_check", sql`${table.noradId} > 0`),
  })
);

export const groundStations = pgTable(
  "ground_stations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: varchar("code", { length: 255 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    altitudeM: doublePrecision("altitude_m").notNull().default(0),
    minimumElevationDeg: doublePrecision("minimum_elevation_deg").notNull(),
    status: groundStationStatusEnum("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    latitudeCheck: check(
      "latitude_check",
      sql`${table.latitude} >= -90 AND ${table.latitude} <= 90`
    ),
    longitudeCheck: check(
      "longitude_check",
      sql`${table.longitude} >= -180 AND ${table.longitude} <= 180`
    ),
    elevationCheck: check(
      "elevation_check",
      sql`${table.minimumElevationDeg} >= 0 AND ${table.minimumElevationDeg} <= 90`
    ),
    altitudeCheck: check(
      "altitude_check",
      sql`${table.altitudeM} >= -500 AND ${table.altitudeM} <= 10000`
    ),
  })
);

export const missionTasks = pgTable(
  "mission_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    satelliteId: uuid("satellite_id")
      .notNull()
      .references(() => satellites.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    priority: integer("priority").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    deadline: timestamp("deadline", { withTimezone: true }).notNull(),
    status: missionTaskStatusEnum("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    satelliteIdIdx: index("satellite_id_idx").on(table.satelliteId),
    priorityCheck: check("priority_check", sql`${table.priority} >= 1 AND ${table.priority} <= 10`),
    durationCheck: check("duration_check", sql`${table.durationSeconds} > 0`),
    idSatDurationUnique: unique("mission_tasks_id_sat_dur_unique").on(table.id, table.satelliteId, table.durationSeconds),
  })
);

export const satelliteOrbitalData = pgTable(
  "satellite_orbital_data",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    satelliteId: uuid("satellite_id")
      .notNull()
      .references(() => satellites.id, { onDelete: "restrict" }),
    source: orbitalDataSourceEnum("source").notNull(),
    tleLine1: varchar("tle_line1", { length: 255 }).notNull(),
    tleLine2: varchar("tle_line2", { length: 255 }).notNull(),
    tleEpoch: timestamp("tle_epoch", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idSatUnique: unique("satellite_orbital_data_id_sat_unique").on(table.id, table.satelliteId),
  })
);

export const contactWindows = pgTable(
  "contact_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    satelliteId: uuid("satellite_id")
      .notNull()
      .references(() => satellites.id, { onDelete: "restrict" }),
    groundStationId: uuid("ground_station_id")
      .notNull()
      .references(() => groundStations.id, { onDelete: "restrict" }),
    orbitalDataId: uuid("orbital_data_id").notNull(),
    aos: timestamp("aos", { withTimezone: true }).notNull(),
    los: timestamp("los", { withTimezone: true }).notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    maxElevationDeg: doublePrecision("max_elevation_deg").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orbitalSatFk: foreignKey({
      columns: [table.orbitalDataId, table.satelliteId],
      foreignColumns: [satelliteOrbitalData.id, satelliteOrbitalData.satelliteId],
      name: "contact_windows_orbital_sat_fk"
    }).onDelete("restrict"),
    aosLosCheck: check("aos_los_check", sql`${table.aos} < ${table.los}`),
    durationCheck: check("duration_check", sql`${table.durationSeconds} > 0`),
    durationMathCheck: check(
      "duration_math_check",
      sql`(${table.durationSeconds})::numeric = EXTRACT(EPOCH FROM (${table.los} - ${table.aos}))`
    ),
    maxElevationCheck: check(
      "max_elevation_check",
      sql`${table.maxElevationDeg} >= 0 AND ${table.maxElevationDeg} <= 90`
    ),
    idStationSatAosLosUnique: unique("contact_windows_id_station_sat_aos_los_unique").on(
      table.id,
      table.groundStationId,
      table.satelliteId,
      table.aos,
      table.los
    ),
  })
);

// Enums for Phase 4
export const reservationStatusEnum = pgEnum("reservation_status", [
  "PENDING",
  "CONFIRMED",
  "CANCELLED",
  "COMPLETED",
  "FAILED",
]);

// Reservations Table
export const reservations = pgTable(
  "reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    missionTaskId: uuid("mission_task_id").notNull(),
    contactWindowId: uuid("contact_window_id").notNull(),
    groundStationId: uuid("ground_station_id").notNull(),
    satelliteId: uuid("satellite_id").notNull(),
    windowAos: timestamp("window_aos", { withTimezone: true }).notNull(),
    windowLos: timestamp("window_los", { withTimezone: true }).notNull(),
    taskDurationSeconds: integer("task_duration_seconds").notNull(),
    allocatedStart: timestamp("allocated_start", { withTimezone: true }).notNull(),
    allocatedEnd: timestamp("allocated_end", { withTimezone: true }).notNull(),
    status: reservationStatusEnum("status").default("PENDING").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    missionTaskFk: foreignKey({
      columns: [table.missionTaskId, table.satelliteId, table.taskDurationSeconds],
      foreignColumns: [missionTasks.id, missionTasks.satelliteId, missionTasks.durationSeconds],
      name: "reservations_mission_task_fk"
    }).onDelete("restrict"),
    contactWindowFk: foreignKey({
      columns: [table.contactWindowId, table.groundStationId, table.satelliteId, table.windowAos, table.windowLos],
      foreignColumns: [contactWindows.id, contactWindows.groundStationId, contactWindows.satelliteId, contactWindows.aos, contactWindows.los],
      name: "reservations_contact_window_fk"
    }).onDelete("restrict"),
    allocatedTimeCheck: check("allocated_time_check", sql`${table.allocatedStart} < ${table.allocatedEnd}`),
    insideWindowCheck: check("inside_window_check", sql`${table.allocatedStart} >= ${table.windowAos} AND ${table.allocatedEnd} <= ${table.windowLos}`),
    durationMatchCheck: check("duration_match_check", sql`(${table.taskDurationSeconds})::numeric = EXTRACT(EPOCH FROM (${table.allocatedEnd} - ${table.allocatedStart}))`),
    oneActiveReservationIdx: uniqueIndex("one_active_reservation_per_task")
      .on(table.missionTaskId)
      .where(sql`status IN ('PENDING', 'CONFIRMED')`),
  })
);

export const schedulerRuns = pgTable("scheduler_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  runType: runTypeEnum("run_type").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  referenceTime: timestamp("reference_time", { withTimezone: true }).notNull(),

  selectedPolicy: varchar("selected_policy", { length: 50 }),
  selectionReason: text("selection_reason"),
  selectorVersion: varchar("selector_version", { length: 50 }),

  taskCount: integer("task_count"),
  totalTaskDemandSeconds: doublePrecision("total_task_demand_seconds"),
  usableCapacitySeconds: doublePrecision("usable_capacity_seconds"),

  loadPressure: doublePrecision("load_pressure"),
  medianDeadlinePressure: doublePrecision("median_deadline_pressure"),
  p10DeadlinePressure: doublePrecision("p10_deadline_pressure"),
  tightTaskFraction: doublePrecision("tight_task_fraction"),
  highPriorityFraction: doublePrecision("high_priority_fraction"),

  meanGapSeconds: doublePrecision("mean_gap_seconds"),
  largestGapSeconds: doublePrecision("largest_gap_seconds"),
  fragmentationPressure: doublePrecision("fragmentation_pressure"),

  scheduledCount: integer("scheduled_count"),
  unscheduledCount: integer("unscheduled_count"),
  executionStatus: executionStatusEnum("execution_status").notNull(),
  errorMessage: text("error_message"),
});
