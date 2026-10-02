import { RealOrbitalDataProvider } from "../modules/data-providers/real-provider";
import { ommToTleLine1, ommToTleLine2 } from "../modules/data-providers/omm-to-tle";
import assert from "assert";

async function runTests() {
  console.log("=== REAL PROVIDER UNIT TESTS (FIXTURES) ===");

  // 1. Test OMM to TLE normalization logic
  const mockOmm = {
    OBJECT_NAME: "METEOSAT-9 (MSG-2)",
    OBJECT_ID: "2005-049B",
    EPOCH: "2026-08-16T03:28:58.729152",
    MEAN_MOTION: 1.0027441,
    ECCENTRICITY: 0.00028442,
    INCLINATION: 9.494,
    RA_OF_ASC_NODE: 53.5603,
    ARG_OF_PERICENTER: 7.0648,
    MEAN_ANOMALY: 1.8433,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: "U",
    NORAD_CAT_ID: 28912,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 760,
    BSTAR: 0,
    MEAN_MOTION_DOT: 0.00000113,
    MEAN_MOTION_DDOT: 0
  };

  const tle1 = ommToTleLine1(mockOmm);
  const tle2 = ommToTleLine2(mockOmm);

  // Assert TLE Line 1
  assert.strictEqual(tle1.substring(0, 1), "1"); // Line num
  assert.strictEqual(tle1.substring(2, 7), "28912"); // NORAD
  assert.strictEqual(tle1.substring(7, 8), "U"); // Classification
  assert.strictEqual(tle1.substring(9, 17), "05049B  "); // Int Designator
  assert.strictEqual(tle1.substring(18, 32), "26228.14512418"); // Epoch (YYDDD.DDDDDDDD)
  assert.strictEqual(tle1.substring(53, 61), " 00000-0"); // BSTAR=0

  // Assert TLE Line 2
  assert.strictEqual(tle2.substring(0, 1), "2"); // Line num
  assert.strictEqual(tle2.substring(2, 7), "28912"); // NORAD
  assert.strictEqual(tle2.substring(8, 16).trim(), "9.4940"); // Inclination
  assert.strictEqual(tle2.substring(17, 25).trim(), "53.5603"); // RAAN
  assert.strictEqual(tle2.substring(26, 33), "0002844"); // Eccentricity (0.00028442)
  assert.strictEqual(tle2.substring(34, 42).trim(), "7.0648"); // Arg Pericenter
  assert.strictEqual(tle2.substring(43, 51).trim(), "1.8433"); // Mean Anomaly
  assert.strictEqual(tle2.substring(52, 63).trim(), "1.00274410"); // Mean Motion

  console.log("✅ OMM JSON correctly normalized to TLE lines");
  
  // 2. Test RealOrbitalDataProvider with mocked fetch
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => [mockOmm],
    text: async () => "METEOSAT-9 (MSG-2)\n1 28912U 05049B   26228.14512418  .00000113  00000+0  00000+0 0  9999\n2 28912   9.4940  53.5603 0002844   7.0648   1.8433  1.00274410  7606"
  } as any);

  try {
    process.env.CELESTRAK_MAX_SATELLITES = "1";
    process.env.CELESTRAK_FORMAT = "json";
    const providerJson = new RealOrbitalDataProvider();
    
    const sats = await providerJson.getSatellites();
    assert.strictEqual(sats.length, 1);
    assert.strictEqual(sats[0]?.noradId, 28912);
    console.log("✅ JSON Satellite fetching successful");
    
    process.env.CELESTRAK_FORMAT = "tle";
    const providerTle = new RealOrbitalDataProvider();
    const satsTle = await providerTle.getSatellites();
    assert.strictEqual(satsTle.length, 1);
    assert.strictEqual(satsTle[0]?.noradId, 28912);
    console.log("✅ TLE fallback Satellite fetching successful");
    
  } finally {
    global.fetch = originalFetch;
  }
}

runTests().catch(err => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
