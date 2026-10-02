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

export const metricsRegistry = client.register;
