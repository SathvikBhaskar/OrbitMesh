import { PilotRunner } from "./runners/pilot-runner";
import { CorpusPair } from "./impact-types";
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const runner = new PilotRunner();
  // We need to fetch 5 real TLE pairs from the corpus JSON.
  const corpusPath = path.join(__dirname, '../../../../research/scheduling-impact/corpus/tle_pairs.json');
  let corpus: CorpusPair[] = [];
  if (fs.existsSync(corpusPath)) {
    corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf-8'));
  } else {
    console.log("No corpus found. Using mock corpus for Pilot 2.");
    // Mock 5 corpus events
    for (let i = 0; i < 5; i++) {
        corpus.push({
            pairId: `mock-pair-${i}`,
            satelliteId: "00000000-0000-0000-0000-000000025544", // ISS for realistic SGP4
            t0: {
                epochMs: new Date().getTime() - 24 * 3600 * 1000,
                tleLine1: "1 25544U 98067A   23277.51352468  .00015509  00000-0  28258-3 0  9997",
                tleLine2: "2 25544  51.6416 112.7562 0004926 230.1332 239.5492 15.50090333418879"
            },
            t1: {
                // Same lines but slightly shifted epoch for mock, SGP4 will use the line 1/2 directly
                // We shift the TLE string to simulate a slight drift
                epochMs: new Date().getTime() - 12 * 3600 * 1000,
                tleLine1: "1 25544U 98067A   23277.91352468  .00015509  00000-0  28258-3 0  9997",
                tleLine2: "2 25544  51.6416 112.7562 0004926 230.1332 245.5492 15.50090333418879"
            }
        });
    }
  }

  await runner.runPilot2(corpus);
}

main().catch(console.error).finally(() => process.exit(0));
