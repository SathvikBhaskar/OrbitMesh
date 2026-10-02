import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { logger } from "../config/logger";
import { env } from "../config/env";

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  // Use pino-http's req.id if available
  const requestId = req.id || "unknown";

  // 1. Handle Zod validation errors
  if (err && err.name === "ZodError") {
    try {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: (err.issues || err.errors || []).map((e: any) => ({
            path: e.path.join("."),
            message: e.message,
          })),
          requestId,
        },
      });
    } catch (e) {
      console.error("Error sending ZodError response:", e);
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Failed to map errors" } });
    }
    return;
  }

  // 2. Map standard known HTTP errors
  const status = err.status || err.statusCode || 500;
  
  if (status !== 500) {
    res.status(status).json({
      error: {
        code: err.code || "CLIENT_ERROR",
        message: err.message || "An error occurred",
        requestId,
      },
    });
    return;
  }

  // 3. Handle unknown internal errors (500)
  logger.error({ err, reqId: requestId }, "Unhandled Internal Server Error");

  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: env.nodeEnv === "development" ? err.message : "Internal server error",
      // Expose stack only in dev for easier debugging, mask in production
      ...(env.nodeEnv === "development" && { stack: err.stack }),
      requestId,
    },
  });
}
