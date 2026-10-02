import "dotenv/config";
import assert from "assert";
import { RealOrbitalDataProvider } from "../modules/data-providers/real-provider";

async function runConfigTests() {
  console.log("=== SCALABILITY CONFIG SAFEGUARDS TEST ===");
  
  // Test 1: Exceeding Hard Limit
  process.env.CELESTRAK_MAX_SATELLITES = "3000";
  process.env.CELESTRAK_MAX_SATELLITES_HARD_LIMIT = "2000";
  
  let caught = false;
  try {
    new RealOrbitalDataProvider();
  } catch (err: any) {
    if (err.message.includes("Configuration Error") && err.message.includes("hard limit is 2000")) {
      caught = true;
    }
  }
  assert(caught, "Provider MUST throw if requested satellites exceeds hard limit");
  console.log("✅ Hard limit safeguard validated");

  // Test 2: Valid scale
  process.env.CELESTRAK_MAX_SATELLITES = "1000";
  let instance: RealOrbitalDataProvider;
  try {
    instance = new RealOrbitalDataProvider();
    console.log("✅ Valid scale allowed");
  } catch (err) {
    assert.fail("Should not throw on valid scale");
  }

  console.log("✅ All config tests passed");
}

runConfigTests().catch(e => {
  console.error(e);
  process.exit(1);
});
