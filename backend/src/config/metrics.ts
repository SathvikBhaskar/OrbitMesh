import client from 'prom-client';

// Enable default Node.js metrics
client.collectDefaultMetrics();

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const schedulerRunsTotal = new client.Counter({
  name: 'orbitmesh_scheduler_runs_total',
  help: 'Total number of MetaScheduler runs',
  labelNames: ['result'] as const, // 'success' or 'error'
});

export const schedulerDurationMs = new client.Histogram({
  name: 'orbitmesh_scheduler_duration_ms',
  help: 'Execution duration of MetaScheduler in milliseconds',
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

export const tleUpdatesTotal = new client.Counter({
  name: 'orbitmesh_tle_updates_total',
  help: 'Total number of successful TLE updates',
});

// =========================================================================
// Phase 5.4 Control Plane Metrics
// =========================================================================
export const controlPlaneEventsIngestedTotal = new client.Counter({
  name: 'control_plane_events_ingested_total',
  help: 'Total number of operational events ingested',
  labelNames: ['event_type', 'urgency'] as const,
});

export const controlPlaneIdempotencyHitsTotal = new client.Counter({
  name: 'control_plane_idempotency_hits_total',
  help: 'Total number of duplicate/replayed events returning cached receipt',
  labelNames: ['event_type'] as const,
});

export const controlPlaneBatchesTotal = new client.Counter({
  name: 'control_plane_batches_total',
  help: 'Total number of operational batches executed',
  labelNames: ['status'] as const,
});

export const controlPlaneEventsCoalescedTotal = new client.Counter({
  name: 'control_plane_events_coalesced_total',
  help: 'Total number of events superseded or coalesced',
  labelNames: ['event_type', 'reason'] as const,
});

export const controlPlaneBatchDurationSeconds = new client.Histogram({
  name: 'control_plane_batch_duration_seconds',
  help: 'Execution duration of operational batches in seconds',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

export const controlPlaneQueueWaitSeconds = new client.Histogram({
  name: 'control_plane_queue_wait_seconds',
  help: 'Time spent in serialized batch queue before execution in seconds',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

export const controlPlaneVersionAdvancesTotal = new client.Counter({
  name: 'control_plane_version_advances_total',
  help: 'Total number of schedule version advances from batch executions',
});

export const controlPlanePreemptionsTotal = new client.Counter({
  name: 'control_plane_preemptions_total',
  help: 'Total number of reservations displaced by operational events',
});

export const controlPlaneRescuesTotal = new client.Counter({
  name: 'control_plane_rescues_total',
  help: 'Total number of displaced tasks rescued or failed rescue',
  labelNames: ['status'] as const,
});

export const controlPlaneFailuresTotal = new client.Counter({
  name: 'control_plane_failures_total',
  help: 'Total number of control plane execution failures',
  labelNames: ['stage'] as const,
});

export const metricsRegistry = client.register;

