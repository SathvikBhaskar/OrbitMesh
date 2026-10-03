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

  // 2. Map PostgreSQL / Drizzle Database Constraints
  const dbCode = err.code || err.cause?.code;
  if (dbCode) {
    logger.error({ err, reqId: requestId, dbCode }, "Database Constraint Violation");

    switch (dbCode) {
      case "23503": // foreign_key_violation
        res.status(400).json({
          error: {
            code: "FOREIGN_KEY_VIOLATION",
            message: "Referenced entity does not exist or operation violates relational dependency constraints",
            requestId,
          },
        });
        return;
      case "23505": // unique_violation
        res.status(409).json({
          error: {
            code: "RESOURCE_CONFLICT",
            message: "A resource with these unique attributes already exists",
            requestId,
          },
        });
        return;
      case "23514": // check_violation
        res.status(400).json({
          error: {
            code: "CONSTRAINT_VIOLATION",
            message: "Operation violates physical or mathematical domain constraints",
            requestId,
          },
        });
        return;
      case "23502": // not_null_violation
        res.status(400).json({
          error: {
            code: "MISSING_REQUIRED_FIELD",
            message: "A required database field was omitted",
            requestId,
          },
        });
        return;
      case "40001": // serialization_failure
        res.status(409).json({
          error: {
            code: "CONCURRENCY_CONFLICT",
            message: "Concurrent transaction conflict. Please retry the operation.",
            requestId,
          },
        });
        return;
    }
  }

  // 3. Map standard known HTTP errors
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

  // 4. Handle unknown internal errors (500)
  logger.error({ err, reqId: requestId }, "Unhandled Internal Server Error");

  // Never expose raw SQL queries or database internal connection strings in client responses
  const rawMessage = typeof err.message === "string" ? err.message : "";
  const isDrizzleQuery = rawMessage.startsWith("Failed query:") || err.type === "DrizzleQueryError";

  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: isDrizzleQuery ? "Internal database operation failed" : (env.nodeEnv === "development" ? err.message : "Internal server error"),
      ...(env.nodeEnv === "development" && !isDrizzleQuery && { stack: err.stack }),
      requestId,
    },
  });
}
