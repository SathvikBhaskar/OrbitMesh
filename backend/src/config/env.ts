import "dotenv/config";

const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port,
  orbitalSyncEnabled: process.env.ORBITAL_SYNC_ENABLED === "true",
  orbitalSyncIntervalSeconds: Number(process.env.ORBITAL_SYNC_INTERVAL_SECONDS ?? 900),
  jwtSecret: process.env.JWT_SECRET || "super-secret-dev-jwt-key",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "15m",
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || "super-secret-dev-refresh-key",
  jwtRefreshExpiresInDays: Number(process.env.JWT_REFRESH_EXPIRES_IN_DAYS ?? 7),
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173"
} as const;

if (env.nodeEnv === "production") {
  if (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === "http://localhost:5173" || process.env.CORS_ORIGIN === "*") {
    console.warn("WARNING: Unsafe or missing CORS_ORIGIN in production environment!");
  }
}
