import express from "express";
import cors from "cors";
import { satellitesRouter } from "./modules/satellites/router";
import { groundStationsRouter } from "./modules/ground-stations/router";
import { missionTasksRouter } from "./modules/mission-tasks/router";
import { schedulerRouter } from "./modules/scheduler/router";
import { contactWindowsRouter } from "./modules/contact-windows/router";
import { reservationsRouter } from "./modules/reservations/router";
import { schedulerRunsRouter } from "./modules/scheduler-runs/router";
import { orbitalSyncRouter } from "./modules/orbital-data/router";
import { executionRouter } from "./modules/execution/router";
import { groundAdapterRouter } from "./modules/ground-adapter/router";
import pinoHttp from "pino-http";
import { logger } from "./config/logger";
import { env } from "./config/env";
import { httpRequestsTotal, httpRequestDurationSeconds, metricsRegistry } from "./config/metrics";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { authRouter } from "./modules/auth/router";
import { authenticate, authorize } from "./middlewares/auth";
import { errorHandler } from "./middlewares/error-handler";

export const app = express();
app.use(helmet());
app.use(cors({ origin: env.corsOrigin, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// 1. Pino Logger Middleware
app.use(pinoHttp({ logger }));

// 2. Metrics Middleware
app.use((req, res, next) => {
  const start = process.hrtime();
  
  res.on('finish', () => {
    const duration = process.hrtime(start);
    const durationSec = duration[0] + duration[1] / 1e9;
    
    // Express attaches the route object after matching
    // Extract base URL and route path to avoid high cardinality on dynamic URLs
    let route = "unknown_route";
    if (req.route && req.route.path) {
      route = `${req.baseUrl || ''}${req.route.path}`;
    } else if (res.statusCode === 404) {
      route = "not_found";
    }

    const labels = {
      method: req.method,
      route,
      status: res.statusCode.toString()
    };

    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSec);
  });
  
  next();
});

// 3. Metrics Endpoint
app.get('/metrics', async (req, res) => {
  if (env.nodeEnv === "production") {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${env.jwtSecret}`) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }
  
  try {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  } catch (ex) {
    res.status(500).end(ex);
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "orbitmesh-api", database: "CONNECTED" });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "orbitmesh-api", database: "CONNECTED" });
});

app.use("/api/auth", authRouter);

// Role constants
const VIEWER_PLUS = ["VIEWER", "OPERATOR", "ADMIN"];
const OPERATOR_PLUS = ["OPERATOR", "ADMIN"];
const ADMIN_ONLY = ["ADMIN"];

app.use("/api/satellites", authenticate, authorize(VIEWER_PLUS), satellitesRouter);
app.use("/api/ground-stations", authenticate, authorize(VIEWER_PLUS), groundStationsRouter);
app.use("/api/contact-windows", authenticate, authorize(VIEWER_PLUS), contactWindowsRouter);
app.use("/api/reservations", authenticate, authorize(VIEWER_PLUS), reservationsRouter);
app.use("/api/scheduler-runs", authenticate, authorize(VIEWER_PLUS), schedulerRunsRouter);

// Operator+ routes
app.use("/api/mission-tasks", authenticate, authorize(OPERATOR_PLUS), missionTasksRouter);
app.use("/api/scheduler", authenticate, authorize(OPERATOR_PLUS), schedulerRouter);
app.use("/api/execution", executionRouter);
app.use("/api/adapter", groundAdapterRouter);

// Admin routes
app.use("/api/orbital-sync", authenticate, authorize(VIEWER_PLUS), orbitalSyncRouter);

// Catch-all for unknown routes
app.use((req, res, next) => {
  const err: any = new Error("Not Found");
  err.status = 404;
  err.code = "NOT_FOUND";
  next(err);
});

// Global Error Handler must be the last middleware
app.use(errorHandler);

