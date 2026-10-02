import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import { GPRecord, CorpusPair, OrbitalClass } from "../impact-types";

const MAX_REQUESTS_PER_24H = 10;
const CHECKPOINT_FILE = path.join(__dirname, '../../../../../research/scheduling-impact/corpus/collection-checkpoint.json');
const RAW_DIR = path.join(__dirname, '../../../../../research/scheduling-impact/corpus/tle_raw');
const PAIRS_FILE = path.join(__dirname, '../../../../../research/scheduling-impact/corpus/tle_pairs.json');
const MANIFEST_FILE = path.join(__dirname, '../../../../../research/scheduling-impact/corpus/corpus-manifest.json');

export interface CollectionCheckpoint {
  dailyRequestsMade: number;
  lastRequestDate: string;
}

export class TLECorpusCollector {
  constructor() {
    if (!fs.existsSync(RAW_DIR)) {
      fs.mkdirSync(RAW_DIR, { recursive: true });
    }
  }

  private getCheckpoint(): CollectionCheckpoint {
    if (!fs.existsSync(CHECKPOINT_FILE)) {
      return { dailyRequestsMade: 0, lastRequestDate: new Date().toISOString().split('T')[0] };
    }
    const data = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8'));
    const today = new Date().toISOString().split('T')[0];
    if (data.lastRequestDate !== today) {
      return { dailyRequestsMade: 0, lastRequestDate: today };
    }
    return data;
  }

  private saveCheckpoint(checkpoint: CollectionCheckpoint) {
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2), 'utf-8');
  }

  /**
   * Abstracted CelesTrak archival fetch. In a real scenario, this hits the GP historical API or
   * parses a downloaded CSV/JSON from the special-data request form.
   */
  public async fetchHistoricalGPData(noradIds: number[], startDate: string, endDate: string): Promise<GPRecord[]> {
    const checkpoint = this.getCheckpoint();
    if (checkpoint.dailyRequestsMade >= MAX_REQUESTS_PER_24H) {
      throw new Error(`CelesTrak rate limit reached: ${MAX_REQUESTS_PER_24H} requests per 24h.`);
    }

    const commaSeparated = noradIds.join(',');
    // CelesTrak's GP historical data endpoint
    const url = `https://celestrak.org/NORAD/elements/gp-history.php?CATNR=${commaSeparated}&FORMAT=json`;
    
    console.log(`Fetching from CelesTrak (Request ${checkpoint.dailyRequestsMade + 1}/${MAX_REQUESTS_PER_24H})...`);
    
    // NOTE: CelesTrak may reject automated large historical fetches without prior approval. 
    // This is structurally correct for the JSON GP format.
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch GP data: ${response.statusText}`);
    }

    const data = (await response.json()) as GPRecord[];

    checkpoint.dailyRequestsMade++;
    this.saveCheckpoint(checkpoint);

    // Save raw records
    const timestamp = Date.now();
    fs.writeFileSync(path.join(RAW_DIR, `raw_${timestamp}.json`), JSON.stringify(data, null, 2));

    return data;
  }

  /**
   * Sorts records by epoch, then pairs adjacent records where gap >= 1h.
   */
  public buildPairs(records: GPRecord[], orbitalClass: OrbitalClass): CorpusPair[] {
    // Group by NORAD ID
    const grouped = new Map<number, GPRecord[]>();
    for (const record of records) {
      const arr = grouped.get(record.NORAD_CAT_ID) || [];
      arr.push(record);
      grouped.set(record.NORAD_CAT_ID, arr);
    }

    const pairs: CorpusPair[] = [];
    const sourceRequestId = crypto.randomUUID();
    const collectionTimestampMs = Date.now();

    for (const [noradId, satRecords] of grouped.entries()) {
      // Sort chronologically by EPOCH
      satRecords.sort((a, b) => new Date(a.EPOCH).getTime() - new Date(b.EPOCH).getTime());

      for (let i = 0; i < satRecords.length - 1; i++) {
        const t0_raw = satRecords[i];
        const t1_raw = satRecords[i + 1];

        const t0_ms = new Date(t0_raw.EPOCH).getTime();
        const t1_ms = new Date(t1_raw.EPOCH).getTime();
        const gapHours = (t1_ms - t0_ms) / (1000 * 60 * 60);

        if (gapHours >= 1.0) {
          // Calculate if manoeuvre suspected based on Mean Motion (Δn) or Inclination (Δi) threshold
          // This is a naive detection logic for the research lab
          const deltaN = Math.abs((t1_raw.MEAN_MOTION || 0) - (t0_raw.MEAN_MOTION || 0));
          const deltaI = Math.abs((t1_raw.INCLINATION || 0) - (t0_raw.INCLINATION || 0));
          const manoeuvreSuspected = deltaN > 0.05 || deltaI > 0.05; 

          const pairId = `${noradId}_${t0_ms}_${t1_ms}`;
          const hashString = JSON.stringify({ t0_raw, t1_raw });
          const hash = crypto.createHash('sha256').update(hashString).digest('hex');

          pairs.push({
            pairId,
            satelliteId: `SAT-${noradId}`,
            noradId,
            orbitalClass,
            t0: { epochMs: t0_ms, raw: t0_raw },
            t1: { epochMs: t1_ms, raw: t1_raw },
            epochGapHours: gapHours,
            sourceRequestId,
            collectionTimestampMs,
            manoeuvreSuspected,
            hash
          });
        }
      }
    }

    return pairs;
  }

  public appendPairsToCorpus(newPairs: CorpusPair[]) {
    let existing: CorpusPair[] = [];
    if (fs.existsSync(PAIRS_FILE)) {
      existing = JSON.parse(fs.readFileSync(PAIRS_FILE, 'utf-8'));
    }

    // Deduplicate by pairId
    const map = new Map(existing.map(p => [p.pairId, p]));
    for (const p of newPairs) {
      map.set(p.pairId, p);
    }

    const merged = Array.from(map.values());
    fs.writeFileSync(PAIRS_FILE, JSON.stringify(merged, null, 2));

    this.updateManifest(merged);
  }

  private updateManifest(pairs: CorpusPair[]) {
    const counts: Record<string, number> = {};
    for (const p of pairs) {
      counts[p.orbitalClass] = (counts[p.orbitalClass] || 0) + 1;
    }
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(counts, null, 2));
  }
}
