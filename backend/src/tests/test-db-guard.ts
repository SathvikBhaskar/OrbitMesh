import { guardLabDatabase } from "../modules/scheduler-lab/lab-db-guard";

console.log(`Testing guard with DATABASE_URL: ${process.env.DATABASE_URL}`);
try {
  guardLabDatabase();
  console.log("GUARD PASSED");
} catch (e) {
  // Should not catch process.exit
}
