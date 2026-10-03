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
  boolean,
  jsonb,
  bigint,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const orbitalDataSourceEnum = pgEnum("orbital_data_source", ["CELESTRAK"]);
export const userRoleEnum = pgEnum("user_role", ["VIEWER", "OPERATOR", "ADMIN"]);

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
export const orbitalSyncStatus = pgEnum("orbital_sync_status", ["RUNNING", "SUCCESS", "FAILED", "SKIPPED"]);

export const executionStateEnum = pgEnum("execution_state", [
  "SCHEDULED",
  "EXECUTION_READY",
  "DISPATCHED",
  "IN_PROGRESS",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
]);

export const executionFailureReasonEnum = pgEnum("execution_failure_reason", [
  "DISPATCH_REJECTED",
  "NO_AOS",
  "GROUND_HARDWARE_FAULT",
  "SATELLITE_UNAVAILABLE",
  "EXECUTION_ABORTED",
  "TIMEOUT",
  "UNKNOWN",
]);

export const dispatchHandshakeStateEnum = pgEnum("dispatch_handshake_state", [
  "PREPARED",
  "STAGED_ACK",
  "ARMED",
  "REJECTED",
  "EXPIRED",
]);

export const adapterTransportHealthEnum = pgEnum("adapter_transport_health", [
  "CONNECTED",
  "COMMUNICATION_GAP",
]);

export const outboxMessageStatusEnum = pgEnum("outbox_message_status", [
  "PENDING",
  "DELIVERING",
  "DELIVERED",
  "RETRY",
  "DLQ",
]);

export const outboxMessageTypeEnum = pgEnum("outbox_message_type", [
  "STAGE_DISPATCH",
  "ARM_DISPATCH",
  "ABORT_PASS",
  "RF_INHIBIT",
  "STATUS_QUERY",
]);

export const executionInterlockStateEnum = pgEnum("execution_interlock_state", [
  "NONE",
  "ABORT_REQUESTED",
  "ABORT_CONFIRMED",
  "ABORT_UNCONFIRMED",
  "RF_INHIBIT_REQUESTED",
  "RF_INHIBIT_CONFIRMED",
  "INTERLOCK_FAILED",
]);

export const stationCredentialStatusEnum = pgEnum("station_credential_status", [
  "ACTIVE",
  "ROTATING",
  "REVOKED",
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
    supportedFrequencyBands: text("supported_frequency_bands")
      .array()
      .notNull()
      .default(sql`ARRAY['S_BAND', 'X_BAND']::text[]`),
    maxConcurrentContacts: integer("max_concurrent_contacts").notNull().default(1),
    maxDataRateMbps: doublePrecision("max_data_rate_mbps").notNull().default(100.0),
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
    maxConcurrentContactsCheck: check(
      "max_concurrent_contacts_check",
      sql`${table.maxConcurrentContacts} > 0`
    ),
    maxDataRateCheck: check(
      "max_data_rate_check",
      sql`${table.maxDataRateMbps} > 0`
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
    requiredFrequencyBand: text("required_frequency_band").notNull().default("S_BAND"),
    minDataRateMbps: doublePrecision("min_data_rate_mbps").notNull().default(10.0),
    targetBytes: bigint("target_bytes", { mode: "number" }).default(1000000000).notNull(),
    fulfilledBytes: bigint("fulfilled_bytes", { mode: "number" }).default(0).notNull(),
    remainingBytes: bigint("remaining_bytes", { mode: "number" }).default(1000000000).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    satelliteIdIdx: index("satellite_id_idx").on(table.satelliteId),
    priorityCheck: check("priority_check", sql`${table.priority} >= 1 AND ${table.priority} <= 10`),
    durationCheck: check("duration_check", sql`${table.durationSeconds} > 0`),
    minDataRateCheck: check("min_data_rate_check", sql`${table.minDataRateMbps} > 0`),
    idSatDurationUnique: unique("mission_tasks_id_sat_dur_unique").on(table.id, table.satelliteId, table.durationSeconds),
    bytesConsistencyCheck: check(
      "mission_tasks_bytes_consistency_check",
      sql`${table.fulfilledBytes} >= 0 AND ${table.fulfilledBytes} <= ${table.targetBytes} AND ${table.remainingBytes} = ${table.targetBytes} - ${table.fulfilledBytes}`
    ),
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
    satEpochUnique: unique("satellite_orbital_data_sat_epoch_unique").on(table.satelliteId, table.tleEpoch),
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
    stationSatAosLosOrbitalUnique: unique("contact_windows_station_sat_aos_los_orbital_unique").on(
      table.groundStationId,
      table.satelliteId,
      table.aos,
      table.los,
      table.orbitalDataId
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

export const reservationSourceEnum = pgEnum("reservation_source", ["AUTOMATED", "MANUAL"]);

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
    source: reservationSourceEnum("source").default("AUTOMATED").notNull(),
    locked: boolean("locked").default(false).notNull(),
    executionState: executionStateEnum("execution_state").default("SCHEDULED").notNull(),
    activeDispatchId: varchar("active_dispatch_id", { length: 64 }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    dispatchAckAt: timestamp("dispatch_ack_at", { withTimezone: true }),
    aosActual: timestamp("aos_actual", { withTimezone: true }),
    losActual: timestamp("los_actual", { withTimezone: true }),
    bytesTransferred: bigint("bytes_transferred", { mode: "number" }).default(0).notNull(),
    failureReason: executionFailureReasonEnum("failure_reason"),
    telemetryMetrics: jsonb("telemetry_metrics").default({}).notNull(),
    executionInterlock: executionInterlockStateEnum("execution_interlock").default("NONE").notNull(),
    interlockRequestedAt: timestamp("interlock_requested_at", { withTimezone: true }),
    interlockConfirmedAt: timestamp("interlock_confirmed_at", { withTimezone: true }),
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
    executionStateIdx: index("reservations_execution_state_idx").on(table.executionState),
    activeDispatchIdIdx: index("reservations_active_dispatch_id_idx").on(table.activeDispatchId),
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

export const orbitalSyncRuns = pgTable("orbital_sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  status: orbitalSyncStatus("status").notNull(),
  provider: varchar("provider", { length: 255 }).notNull(),
  requestedSatelliteCount: integer("requested_satellite_count"),
  fetchedCount: integer("fetched_count"),
  discoveredCount: integer("discovered_count"),
  updatedCount: integer("updated_count"),
  ignoredCount: integer("ignored_count"),
  rejectedCount: integer("rejected_count"),
  regeneratedSatelliteCount: integer("regenerated_satellite_count"),
  regeneratedWindowCount: integer("regenerated_window_count"),
  errorMessage: text("error_message"),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  role: userRoleEnum("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 255 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index("refresh_tokens_user_id_idx").on(table.userId),
    tokenHashIdx: index("refresh_tokens_token_hash_idx").on(table.tokenHash),
  })
);

export const scheduleVersions = pgTable("schedule_versions", {
  id: integer("id").primaryKey().default(1),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const scheduleAuditLog = pgTable("schedule_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  entityType: varchar("entity_type", { length: 50 }).notNull(),
  entityId: varchar("entity_id", { length: 255 }).notNull(),
  action: varchar("action", { length: 50 }).notNull(),
  beforeState: jsonb("before_state"),
  afterState: jsonb("after_state"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const scheduleProposals = pgTable("schedule_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  scheduleVersion: integer("schedule_version").notNull(),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const operationalEventLedger = pgTable(
  "operational_event_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull().unique(),
    eventType: varchar("event_type", { length: 50 }).notNull(),
    urgency: varchar("urgency", { length: 20 }).notNull().default("COALESCIBLE"),
    payload: jsonb("payload").notNull(),
    status: varchar("status", { length: 50 }).notNull().default("RECEIVED"),
    batchId: uuid("batch_id"),
    executionReceipt: jsonb("execution_receipt"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyKeyIdx: uniqueIndex("operational_event_ledger_idempotency_key_idx").on(table.idempotencyKey),
    statusIdx: index("operational_event_ledger_status_idx").on(table.status),
    batchIdIdx: index("operational_event_ledger_batch_id_idx").on(table.batchId),
  })
);

export const operationalBatches = pgTable(
  "operational_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: varchar("status", { length: 50 }).notNull().default("PROCESSING"),
    scheduleVersionBefore: integer("schedule_version_before").notNull(),
    scheduleVersionAfter: integer("schedule_version_after").notNull(),
    eventCount: integer("event_count").notNull().default(0),
    eventIds: jsonb("event_ids").notNull(),
    summary: jsonb("summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    statusIdx: index("operational_batches_status_idx").on(table.status),
  })
);

export const executionTelemetryEvents = pgTable(
  "execution_telemetry_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => reservations.id, { onDelete: "cascade" }),
    dispatchId: varchar("dispatch_id", { length: 64 }).notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    sequenceNumber: integer("sequence_number").notNull(),
    sourceTimestamp: timestamp("source_timestamp", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull().unique(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    resDispatchIdx: index("execution_telemetry_events_res_dispatch_idx").on(table.reservationId, table.dispatchId),
    resSeqIdx: index("execution_telemetry_events_res_seq_idx").on(table.reservationId, table.sequenceNumber),
  })
);

export const dispatchAttempts = pgTable(
  "dispatch_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => reservations.id, { onDelete: "cascade" }),
    dispatchId: varchar("dispatch_id", { length: 64 }).notNull().unique(),
    attemptNumber: integer("attempt_number").notNull().default(1),
    state: dispatchHandshakeStateEnum("state").notNull().default("PREPARED"),
    transportHealth: adapterTransportHealthEnum("transport_health").notNull().default("CONNECTED"),
    clockOffsetMs: integer("clock_offset_ms").default(0),
    stagedAt: timestamp("staged_at", { withTimezone: true }),
    armedAt: timestamp("armed_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    retryCount: integer("retry_count").notNull().default(0),
    lastError: text("last_error"),
    metadata: jsonb("metadata").default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    resAttemptIdx: unique("uq_dispatch_attempt_num").on(table.reservationId, table.attemptNumber),
    resIdIdx: index("idx_dispatch_attempts_res_id").on(table.reservationId),
    stateIdx: index("idx_dispatch_attempts_state").on(table.state),
  })
);

export const outboundDispatchMessages = pgTable(
  "outbound_dispatch_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: varchar("message_id", { length: 64 }).notNull().unique(),
    dispatchId: varchar("dispatch_id", { length: 64 })
      .notNull()
      .references(() => dispatchAttempts.dispatchId, { onDelete: "restrict" }),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => reservations.id, { onDelete: "restrict" }),
    providerId: varchar("provider_id", { length: 64 }).notNull(),
    messageType: outboxMessageTypeEnum("message_type").notNull(),
    payload: jsonb("payload").default(sql`'{}'::jsonb`).notNull(),
    status: outboxMessageStatusEnum("status").default("PENDING").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    pendingIdx: index("outbound_dispatch_pending_idx").on(table.status, table.nextAttemptAt),
    resIdx: index("outbound_dispatch_res_idx").on(table.reservationId),
    dispIdx: index("outbound_dispatch_disp_idx").on(table.dispatchId),
  })
);

export const groundStationCredentials = pgTable(
  "ground_station_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groundStationId: uuid("ground_station_id")
      .notNull()
      .references(() => groundStations.id, { onDelete: "cascade" }),
    keyId: varchar("key_id", { length: 64 }).notNull().unique(),
    secretKey: text("secret_key").notNull(),
    status: stationCredentialStatusEnum("status").default("ACTIVE").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    stationIdx: index("idx_gs_credentials_station").on(table.groundStationId),
    keyIdIdx: index("idx_gs_credentials_key_id").on(table.keyId),
    statusIdx: index("idx_gs_credentials_status").on(table.status),
  })
);


