import * as fs from 'fs';
import { TLECorpusCollector } from "./tle-corpus/collector";
import { OrbitalClass } from "./impact-types";

async function main() {
    const collector = new TLECorpusCollector();
    const ids: number[] = JSON.parse(fs.readFileSync('selected_100.json', 'utf-8'));
    
    console.log(`Starting historical fetch for ${ids.length} satellites...`);
    // Split into chunks of 100 since CelesTrak allows up to 100
    // Actually we only have 100, so we can do it in one request!
    
    // We want history over the last 14 days, CelesTrak returns the available data
    try {
        const records = await collector.fetchHistoricalGPData(ids, "", ""); // dates are optional/ignored by default (returns last 30 days)
        console.log(`Fetched ${records.length} historical records.`);

        // Classify records
        const leoCirc = records.filter(isLeoCircular);
        const leoSso = records.filter(isLeoSSO);
        const geo = records.filter(isGeo);
        const meo = records.filter(isMeo);

        const pairsCirc = collector.buildPairs(leoCirc, "LEO_CIRCULAR");
        const pairsSso = collector.buildPairs(leoSso, "LEO_SSO");
        const pairsGeo = collector.buildPairs(geo, "GEO");
        const pairsMeo = collector.buildPairs(meo, "MEO");

        console.log(`Generated pairs: LEO_CIRCULAR=${pairsCirc.length}, LEO_SSO=${pairsSso.length}, GEO=${pairsGeo.length}, MEO=${pairsMeo.length}`);

        collector.appendPairsToCorpus(pairsCirc);
        collector.appendPairsToCorpus(pairsSso);
        collector.appendPairsToCorpus(pairsGeo);
        collector.appendPairsToCorpus(pairsMeo);

        console.log("Appended to corpus successfully.");

    } catch (err: any) {
        console.error("Collection failed:", err.message);
    }
}

function isLeoCircular(sat: any) {
    const mm = sat.MEAN_MOTION;
    const inc = sat.INCLINATION;
    return mm > 11.25 && inc < 80;
}

function isLeoSSO(sat: any) {
    const mm = sat.MEAN_MOTION;
    const inc = sat.INCLINATION;
    return mm > 11.25 && inc >= 95 && inc <= 105;
}

function isGeo(sat: any) {
    const mm = sat.MEAN_MOTION;
    const inc = sat.INCLINATION;
    return mm >= 0.99 && mm <= 1.01 && inc < 20;
}

function isMeo(sat: any) {
    const mm = sat.MEAN_MOTION;
    return mm > 1.5 && mm < 5;
}

main().catch(console.error).finally(() => process.exit(0));
