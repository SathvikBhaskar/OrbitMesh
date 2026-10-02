import fs from "fs";
import path from "path";

// Deterministic UUID helper
function makeUuid(prefix: number, index: number): string {
  const p = prefix.toString().padStart(8, "0");
  const i = index.toString().padStart(12, "0");
  return `${p}-0000-4000-8000-${i}`;
}

const baseTime = new Date("2026-10-15T00:00:00.000Z").getTime();

// 1. 5 Satellites
const satellites = [
  { id: makeUuid(1, 1), noradId: 51001, name: "Sentinel-LEO-1", type: "LEO", status: "ACTIVE" },
  { id: makeUuid(1, 2), noradId: 51002, name: "Sentinel-LEO-2", type: "LEO", status: "ACTIVE" },
  { id: makeUuid(1, 3), noradId: 51003, name: "CartoSat-LEO-3", type: "LEO", status: "ACTIVE" },
  { id: makeUuid(1, 4), noradId: 51004, name: "OceanView-LEO-4", type: "LEO", status: "ACTIVE" },
  { id: makeUuid(1, 5), noradId: 51005, name: "RadarSat-LEO-5", type: "LEO", status: "ACTIVE" },
];

const orbitalData = satellites.map((s, idx) => ({
  id: makeUuid(5, idx + 1),
  satelliteId: s.id,
  source: "CELESTRAK",
  tleLine1: "1 25544U 98067A   20286.53610996  .00001091  00000-0  27575-4 0  9997",
  tleLine2: "2 25544  51.6441 341.3418 0001272 133.0036  36.5681 15.49502949250495",
  tleEpoch: new Date(baseTime).toISOString(),
  receivedAt: new Date(baseTime).toISOString(),
}));

// 2. 4 Ground Stations with varied bands and channel capacities
const groundStations = [
  {
    id: makeUuid(2, 1),
    code: "GS-SVALBARD-POLAR",
    name: "Svalbard Polar SuperStation",
    latitude: 78.2297,
    longitude: 15.4077,
    altitudeM: 400,
    minimumElevationDeg: 5,
    status: "AVAILABLE",
    supportedFrequencyBands: ["S_BAND", "X_BAND", "KA_BAND"],
    maxConcurrentContacts: 3,
    maxDataRateMbps: 300.0,
  },
  {
    id: makeUuid(2, 2),
    code: "GS-TROLL-ANTARCTIC",
    name: "Troll Antarctic DualStation",
    latitude: -72.0114,
    longitude: 2.535,
    altitudeM: 1270,
    minimumElevationDeg: 5,
    status: "AVAILABLE",
    supportedFrequencyBands: ["S_BAND", "X_BAND"],
    maxConcurrentContacts: 2,
    maxDataRateMbps: 150.0,
  },
  {
    id: makeUuid(2, 3),
    code: "GS-HARTEBEESTHOEK",
    name: "Hartebeesthoek S-Band Single",
    latitude: -25.8872,
    longitude: 27.7078,
    altitudeM: 1415,
    minimumElevationDeg: 10,
    status: "AVAILABLE",
    supportedFrequencyBands: ["S_BAND"],
    maxConcurrentContacts: 1,
    maxDataRateMbps: 50.0,
  },
  {
    id: makeUuid(2, 4),
    code: "GS-SINGAPORE-EQ",
    name: "Singapore Equatorial X-Band",
    latitude: 1.3521,
    longitude: 103.8198,
    altitudeM: 15,
    minimumElevationDeg: 10,
    status: "AVAILABLE",
    supportedFrequencyBands: ["X_BAND"],
    maxConcurrentContacts: 1,
    maxDataRateMbps: 200.0,
  },
];

// 3. 50 Contact Windows across the 5 satellites and 4 stations
// Distributed over a 48 hour span (172,800 seconds)
const contactWindows: any[] = [];
let winCounter = 1;

for (let satIdx = 0; satIdx < satellites.length; satIdx++) {
  const sat = satellites[satIdx]!;
  const od = orbitalData[satIdx]!;

  // 10 passes per satellite across 48 hours (~1 pass every 4.8h)
  for (let p = 0; p < 10; p++) {
    // Choose ground station cycling
    const stnIdx = (satIdx + p) % groundStations.length;
    const stn = groundStations[stnIdx]!;

    const passStartOffsetSeconds = p * 16000 + (satIdx * 2400) + 1800;
    const durationSeconds = 600 + ((p * 37) % 300); // 600s to 899s (10 to 15 min)
    const aosTime = new Date(baseTime + passStartOffsetSeconds * 1000);
    const losTime = new Date(aosTime.getTime() + durationSeconds * 1000);
    const maxElev = 25 + ((p * 17 + satIdx * 11) % 65); // 25 to 89 deg

    contactWindows.push({
      id: makeUuid(3, winCounter),
      satelliteId: sat.id,
      groundStationId: stn.id,
      orbitalDataId: od.id,
      aos: aosTime.toISOString(),
      los: losTime.toISOString(),
      durationSeconds,
      maxElevationDeg: maxElev,
      status: "AVAILABLE",
    });
    winCounter++;
  }
}

// 4. 60 Competing Mission Tasks across calibrated contention regimes
const missionTasks: any[] = [];
let taskCounter = 1;

// Regimes:
// 1. Critical Slack (15 tasks): high or low priority, tight deadline near first passes
// 2. High Priority Ample Slack (15 tasks): priority 8-10, ample deadline +36h to +48h
// 3. Medium Priority Balanced (15 tasks): priority 4-7, moderate deadline +12h to +24h
// 4. Hardware/Band Restricted (15 tasks): requiring specific RF bands or high data rates

for (let r = 0; r < 4; r++) {
  for (let i = 0; i < 15; i++) {
    const sat = satellites[(i + r) % satellites.length]!;
    const createdOffsetSec = ((i * 300) + (r * 1800));
    const createdAt = new Date(baseTime + createdOffsetSec * 1000);

    let priority = 5;
    let durationSeconds = 180;
    let deadlineOffsetSec = 7200;
    let requiredBand = "S_BAND";
    let minDataRate = 20.0;
    let regimeName = "";

    if (r === 0) {
      // Regime 1: Critical Slack
      regimeName = "Critical-Slack";
      priority = (i % 2 === 0) ? 2 : 9; // alternating high and low priority under critical slack
      durationSeconds = 120 + ((i % 3) * 60); // 120s to 240s
      deadlineOffsetSec = 7200 + (i * 2400); // 2h to 12h
      requiredBand = (i % 3 === 0) ? "X_BAND" : "S_BAND";
      minDataRate = 30.0;
    } else if (r === 1) {
      // Regime 2: High Priority Ample Slack
      regimeName = "HighPrio-AmpleSlack";
      priority = 8 + (i % 3); // 8, 9, 10
      durationSeconds = 240 + ((i % 4) * 60); // 240s to 420s
      deadlineOffsetSec = 86400 + (i * 5400); // +24h to +46h
      requiredBand = (i % 2 === 0) ? "S_BAND" : "X_BAND";
      minDataRate = 40.0;
    } else if (r === 2) {
      // Regime 3: Medium Priority Balanced
      regimeName = "MedPrio-Balanced";
      priority = 4 + (i % 4); // 4, 5, 6, 7
      durationSeconds = 180 + ((i % 3) * 60); // 180s to 300s
      deadlineOffsetSec = 36000 + (i * 3600); // +10h to +25h
      requiredBand = "S_BAND";
      minDataRate = 25.0;
    } else {
      // Regime 4: Hardware/Band Restricted
      regimeName = "Hardware-Restricted";
      priority = 6 + (i % 4);
      durationSeconds = 180;
      deadlineOffsetSec = 43200 + (i * 3600);
      if (i < 5) {
        // Must use KA_BAND (only Svalbard can service)
        requiredBand = "KA_BAND";
        minDataRate = 100.0;
      } else if (i < 10) {
        // High data rate (requires >= 120 Mbps, cannot use Hartebeesthoek)
        requiredBand = "X_BAND";
        minDataRate = 120.0;
      } else {
        // Standard X-band
        requiredBand = "X_BAND";
        minDataRate = 50.0;
      }
    }

    const deadline = new Date(baseTime + deadlineOffsetSec * 1000);

    missionTasks.push({
      id: makeUuid(4, taskCounter),
      satelliteId: sat.id,
      name: `Task-${regimeName}-${taskCounter}`,
      priority,
      durationSeconds,
      deadline: deadline.toISOString(),
      requiredFrequencyBand: requiredBand,
      minDataRateMbps: minDataRate,
      status: "PENDING",
      createdAt: createdAt.toISOString(),
    });
    taskCounter++;
  }
}

const workload = {
  version: "4.3.0",
  referenceTime: new Date(baseTime).toISOString(),
  description: "Phase 4.3 Deterministic Fixed Benchmark Workload: 5 Satellites, 4 Stations, 50 Windows, 60 Tasks",
  satellites,
  orbitalData,
  groundStations,
  contactWindows,
  missionTasks,
};

const outputPath = path.join(__dirname, "phase4-benchmark-workload.json");
fs.writeFileSync(outputPath, JSON.stringify(workload, null, 2), "utf-8");
console.log(`Successfully generated benchmark fixture with ${satellites.length} satellites, ${groundStations.length} stations, ${contactWindows.length} contact windows, and ${missionTasks.length} tasks at ${outputPath}`);
