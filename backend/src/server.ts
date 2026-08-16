import { app } from "./app";
import { env } from "./config/env";
import { checkDatabaseConnection } from "./db/health";

async function start(): Promise<void> {
  await checkDatabaseConnection();

  app.listen(env.port, () => {
    console.log(
      `OrbitMesh API running on http://localhost:${env.port}`,
    );
  });
}

start().catch((error: unknown) => {
  console.error("Failed to start OrbitMesh API:", error);
  process.exit(1);
});
