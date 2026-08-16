export function guardLabDatabase() {
  const dbUrl = process.env.DATABASE_URL;

  if (!dbUrl) {
    console.error("LAB DATABASE SAFETY CHECK FAILED\nExpected database: orbitmesh_lab\nActual database: undefined\nRefusing to continue.");
    process.exit(1);
  }

  try {
    const url = new URL(dbUrl);
    // Pathname starts with '/' e.g., '/orbitmesh_lab'
    const dbName = url.pathname.slice(1);

    if (dbName !== "orbitmesh_lab") {
      console.error(`LAB DATABASE SAFETY CHECK FAILED\nExpected database: orbitmesh_lab\nActual database: ${dbName}\nRefusing to continue.`);
      process.exit(1);
    }

    console.log("Scheduler Lab\nDatabase: orbitmesh_lab\nEnvironment: EXPERIMENT\n");
  } catch (err) {
    console.error("LAB DATABASE SAFETY CHECK FAILED\nExpected database: orbitmesh_lab\nActual database: [Invalid URL]\nRefusing to continue.");
    process.exit(1);
  }
}
