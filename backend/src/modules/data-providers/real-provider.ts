import { OrbitalDataProvider, NewSatellite, NewGroundStation, NewSatelliteOrbitalData } from "./orbital-data-provider";
import { ommToTleLine1, ommToTleLine2 } from "./omm-to-tle";

import { TelemetrySink } from "../../utils/telemetry";

export class RealOrbitalDataProvider implements OrbitalDataProvider {
  private group: string;
  private format: "json" | "tle";
  private maxSatellites: number;
  private telemetry?: TelemetrySink;
  private readonly CELESTRAK_BASE = "https://celestrak.org/NORAD/elements/gp.php";

  constructor() {
    this.group = process.env.CELESTRAK_GROUP || "weather";
    this.format = (process.env.CELESTRAK_FORMAT as "json" | "tle") || "json";
    this.maxSatellites = parseInt(process.env.CELESTRAK_MAX_SATELLITES || "50", 10);
    const hardLimit = parseInt(process.env.CELESTRAK_MAX_SATELLITES_HARD_LIMIT || "2000", 10);
    
    if (this.maxSatellites > hardLimit) {
      throw new Error(`Configuration Error: Requested ${this.maxSatellites} satellites, but hard limit is ${hardLimit}`);
    }
  }

  setTelemetry(telemetry: TelemetrySink) {
    this.telemetry = telemetry;
  }

  async getSatellites(): Promise<NewSatellite[]> {
    let t = performance.now();
    const data = await this.fetchData();
    if (this.telemetry) this.telemetry.recordTime("download", performance.now() - t);
    
    t = performance.now();
    const sats: NewSatellite[] = [];
    
    if (this.format === "json") {
      if (this.telemetry) this.telemetry.increment("satellites_retrieved", data.length);
      for (const item of data) {
        if (sats.length >= this.maxSatellites) break;
        sats.push({
          noradId: parseInt(item.NORAD_CAT_ID, 10),
          name: item.OBJECT_NAME || `SAT-${item.NORAD_CAT_ID}`,
          status: "ACTIVE"
        });
      }
    } else {
      // Parse 3-line TLE format
      const lines = data.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
      if (this.telemetry) this.telemetry.increment("satellites_retrieved", Math.floor(lines.length / 3));
      for (let i = 0; i < lines.length; i += 3) {
        if (sats.length >= this.maxSatellites) break;
        const name = lines[i];
        const line1 = lines[i+1];
        if (!name || !line1) continue;
        const noradId = parseInt(line1.substring(2, 7).trim(), 10);
        sats.push({ noradId, name, status: "ACTIVE" });
      }
    }
    
    if (this.telemetry) this.telemetry.recordTime("parsing", performance.now() - t);
    return sats;
  }

  async getGroundStations(): Promise<NewGroundStation[]> {
    // Provenance: KSAT (Kongsberg Satellite Services) public facility locations
    // Coordinates are approximate facility coordinates based on public documentation.
    // Elevations are set to a standard 10 degrees mask for commercial operations.
    const stationConfigs = [
      { 
        code: "KSAT-SVAL", 
        name: "KSAT Svalbard (SvalSat), Norway", 
        latitude: 78.2297, 
        longitude: 15.4077,
        altitudeM: 400 
      },
      { 
        code: "KSAT-TROL", 
        name: "KSAT Troll (TrollSat), Antarctica", 
        latitude: -72.0114, 
        longitude: 2.5333,
        altitudeM: 1270 
      },
      { 
        code: "KSAT-INUV", 
        name: "KSAT Inuvik, Canada", 
        latitude: 68.3607, 
        longitude: -133.7230,
        altitudeM: 68 
      },
      { 
        code: "KSAT-PUNT", 
        name: "KSAT Punta Arenas, Chile", 
        latitude: -53.1638, 
        longitude: -70.9367,
        altitudeM: 30 
      }
    ];

    return stationConfigs.map(s => ({
      ...s,
      minimumElevationDeg: 10,
      status: "AVAILABLE" as const
    }));
  }

  async getOrbitalData(satelliteIds: string[]): Promise<NewSatelliteOrbitalData[]> {
    let t = performance.now();
    const data = await this.fetchData();
    if (this.telemetry) this.telemetry.recordTime("download", performance.now() - t);
    
    t = performance.now();
    const results: NewSatelliteOrbitalData[] = [];
    
    if (this.format === "json") {
      // We need to map the internal DB UUIDs (satelliteIds) to the NORAD IDs returned in the data
      // Wait, getOrbitalData takes UUIDs. We need the corresponding noradIds to match with CelesTrak.
      // But we can't easily query the DB from here without coupling to DB logic.
      // However, we just fetched the SAME dataset and mapped them in order, or we can look up by index if we assume deterministic ordering.
      // To keep it clean and robust, we assume the caller passes satelliteIds matching the exact order returned by getSatellites(),
      // because seed.ts inserts them and then immediately calls getOrbitalData(sats.map(s => s.id)).
      // This allows us to just zip the arrays.
      for (let i = 0; i < satelliteIds.length && i < data.length; i++) {
        const item = data[i];
        const satId = satelliteIds[i];
        if (!satId) continue;
        
        results.push({
          satelliteId: satId,
          source: "CELESTRAK",
          tleLine1: ommToTleLine1(item),
          tleLine2: ommToTleLine2(item),
          tleEpoch: new Date(item.EPOCH),
          receivedAt: new Date()
        });
      }
    } else {
      const lines = data.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
      let satIndex = 0;
      for (let i = 0; i < lines.length && satIndex < satelliteIds.length; i += 3) {
        const line1 = lines[i+1];
        const line2 = lines[i+2];
        const satId = satelliteIds[satIndex];
        if (!line1 || !line2 || !satId) continue;
        
        // Extract epoch from Line 1 (cols 19-32)
        const yearTwoDigit = parseInt(line1.substring(18, 20), 10);
        const dayOfYear = parseFloat(line1.substring(20, 32));
        const year = (yearTwoDigit < 57 ? 2000 : 1900) + yearTwoDigit;
        const tleEpoch = new Date(Date.UTC(year, 0, 1));
        tleEpoch.setUTCMilliseconds((dayOfYear - 1) * 24 * 60 * 60 * 1000);
        
        results.push({
          satelliteId: satId,
          source: "CELESTRAK",
          tleLine1: line1,
          tleLine2: line2,
          tleEpoch,
          receivedAt: new Date()
        });
        satIndex++;
      }
    }

    if (this.telemetry) {
      this.telemetry.recordTime("parsing", performance.now() - t);
      this.telemetry.increment("satellites_parsed", results.length);
    }
    return results;
  }

  /**
   * Fetches data from CelesTrak with timeout and basic error handling.
   * To respect CelesTrak's usage policies, this could later be enhanced with file-based caching.
   */
  private async fetchData(): Promise<any> {
    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");
    
    const cacheFile = path.join(os.tmpdir(), `celestrak_${this.group}_${this.format}.cache`);
    
    // Check cache
    try {
      if (fs.existsSync(cacheFile)) {
        const stats = fs.statSync(cacheFile);
        const ageMs = Date.now() - stats.mtimeMs;
        if (ageMs < 2 * 60 * 60 * 1000) { // 2 hours
          const cachedData = fs.readFileSync(cacheFile, 'utf-8');
          if (this.format === "json") return JSON.parse(cachedData);
          return cachedData;
        }
      }
    } catch (e) {
      console.warn("Failed to read CelesTrak cache:", e);
    }

    const url = `${this.CELESTRAK_BASE}?GROUP=${this.group}&FORMAT=${this.format}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout
    
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "OrbitMesh/1.0" } });
      if (!res.ok) {
        throw new Error(`CelesTrak HTTP Error: ${res.status} ${res.statusText}`);
      }
      
      let rawData = await res.text();
      
      try {
        fs.writeFileSync(cacheFile, rawData);
      } catch (e) {
        console.warn("Failed to write CelesTrak cache:", e);
      }

      if (this.format === "json") {
        const json = JSON.parse(rawData);
        if (!json || !Array.isArray(json) || json.length === 0) {
          throw new Error("CelesTrak returned empty or invalid JSON array.");
        }
        return json;
      } else {
        if (!rawData || rawData.trim().length === 0) {
          throw new Error("CelesTrak returned empty TLE text.");
        }
        return rawData;
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(`CelesTrak request timed out after 60 seconds.`);
      }
      throw new Error(`Failed to fetch CelesTrak data: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
