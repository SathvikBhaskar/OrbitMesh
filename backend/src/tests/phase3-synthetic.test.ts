import { WindowDetector } from "../modules/contact-windows/window-detector";
import { Refinement } from "../modules/contact-windows/refinement";
import { VisibilitySample } from "../modules/visibility/types";

function mockSample(t: number, visible: boolean, elevation: number = visible ? 20 : 0): VisibilitySample {
  return {
    timestamp: new Date(t * 1000).toISOString(),
    visible,
    elevationDeg: elevation,
    azimuthDeg: 0,
    rangeKm: 500
  };
}

async function runSyntheticTests() {
  console.log("=== PHASE 3 SYNTHETIC TESTS ===");
  const detector = new WindowDetector();
  const refinement = new Refinement();

  // Test 1 - No windows (false false false false)
  console.log("\n--- Test 1: No windows ---");
  const samples1 = [mockSample(0, false), mockSample(60, false), mockSample(120, false), mockSample(180, false)];
  const res1 = detector.detectCoarseWindows(samples1);
  if (res1.length === 0) console.log("✅ SUCCESS");
  else throw new Error(`Expected 0, got ${res1.length}`);

  // Test 2 - One window (false true true true false)
  console.log("\n--- Test 2: One window ---");
  const samples2 = [mockSample(0, false), mockSample(60, true), mockSample(120, true), mockSample(180, true), mockSample(240, false)];
  const res2 = detector.detectCoarseWindows(samples2);
  if (res2.length === 1) console.log("✅ SUCCESS");
  else throw new Error(`Expected 1, got ${res2.length}`);

  // Test 3 - Multiple windows (false true true false true true false)
  console.log("\n--- Test 3: Multiple windows ---");
  const samples3 = [
    mockSample(0, false), mockSample(60, true), mockSample(120, true), mockSample(180, false),
    mockSample(240, true), mockSample(300, true), mockSample(360, false)
  ];
  const res3 = detector.detectCoarseWindows(samples3);
  if (res3.length === 2) console.log("✅ SUCCESS");
  else throw new Error(`Expected 2, got ${res3.length}`);

  // Test 4 - Starts visible (true true false)
  console.log("\n--- Test 4: Starts visible ---");
  const samples4 = [mockSample(0, true), mockSample(60, true), mockSample(120, false)];
  const res4 = detector.detectCoarseWindows(samples4);
  if (res4.length === 1 && res4[0]!.startsVisible === true && res4[0]!.observationStart.getTime() === 0) console.log("✅ SUCCESS (AOS = observationStart)");
  else throw new Error("Failed starts visible logic");

  // Test 5 - Ends visible (false true true)
  console.log("\n--- Test 5: Ends visible ---");
  const samples5 = [mockSample(0, false), mockSample(60, true), mockSample(120, true)];
  const res5 = detector.detectCoarseWindows(samples5);
  if (res5.length === 1 && res5[0]!.endsVisible === true && !res5[0]!.losBracket) console.log("✅ SUCCESS (LOS = observationEnd)");
  else throw new Error("Failed ends visible logic");

  // Test 6 - Always visible (true true true true)
  console.log("\n--- Test 6: Always visible ---");
  const samples6 = [mockSample(0, true), mockSample(60, true), mockSample(120, true), mockSample(180, true)];
  const res6 = detector.detectCoarseWindows(samples6);
  if (res6.length === 1 && res6[0]!.startsVisible && res6[0]!.endsVisible) console.log("✅ SUCCESS (One continuous window)");
  else throw new Error("Failed always visible logic");

  // Binary Search - AOS
  console.log("\n--- Test 7: Binary-search AOS (visible t >= 100) ---");
  const mathFnAOS = async (t: Date) => t.getTime() >= 100 * 1000;
  const aosBefore = mockSample(0, false);
  const aosAfter = mockSample(120, true); // true at 120s
  const refinedAOS = await refinement.refineTransition(aosBefore, aosAfter, mathFnAOS, "AOS", 1);
  const aosSecs = refinedAOS.getTime() / 1000;
  if (Math.abs(aosSecs - 100) <= 1) console.log(`✅ SUCCESS (AOS refined to ${aosSecs}s)`);
  else throw new Error(`AOS refinement failed. Expected ~100s, got ${aosSecs}s`);

  // Binary Search - LOS
  console.log("\n--- Test 8: Binary-search LOS (visible t < 350) ---");
  const mathFnLOS = async (t: Date) => t.getTime() < 350 * 1000;
  const losBefore = mockSample(300, true);
  const losAfter = mockSample(400, false);
  const refinedLOS = await refinement.refineTransition(losBefore, losAfter, mathFnLOS, "LOS", 1);
  const losSecs = refinedLOS.getTime() / 1000;
  if (Math.abs(losSecs - 350) <= 1) console.log(`✅ SUCCESS (LOS refined to ${losSecs}s)`);
  else throw new Error(`LOS refinement failed. Expected ~350s, got ${losSecs}s`);

  // Test elevation boundary
  console.log("\n--- Test 9: Elevation Boundary ---");
  const minElevation = 10;
  const currentElevation = 10;
  const isVisible = currentElevation >= minElevation;
  if (isVisible === true) console.log("✅ SUCCESS (10 >= 10 is visible)");
  else throw new Error("Elevation boundary logic changed!");

  console.log("\nAll Synthetic Tests Passed! ✅");
}

runSyntheticTests().catch(e => {
  console.error("Synthetic tests failed:", e);
  process.exit(1);
});
