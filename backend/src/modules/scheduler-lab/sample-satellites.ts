import * as fs from 'fs';
import { OrbitalClass } from "./impact-types";

async function main() {
    console.log("Fetching active catalog...");
    const res = await fetch("https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json");
    const data = await res.json() as any[];
    console.log(`Fetched ${data.length} active satellites.`);

    const selected = new Map<OrbitalClass, number[]>();
    selected.set("LEO_CIRCULAR", []);
    selected.set("LEO_SSO", []);
    selected.set("GEO", []);
    selected.set("MEO", []);

    for (const sat of data) {
        if (selected.get("LEO_CIRCULAR")!.length < 25 && isLeoCircular(sat)) selected.get("LEO_CIRCULAR")!.push(sat.NORAD_CAT_ID);
        else if (selected.get("LEO_SSO")!.length < 25 && isLeoSSO(sat)) selected.get("LEO_SSO")!.push(sat.NORAD_CAT_ID);
        else if (selected.get("GEO")!.length < 25 && isGeo(sat)) selected.get("GEO")!.push(sat.NORAD_CAT_ID);
        else if (selected.get("MEO")!.length < 25 && isMeo(sat)) selected.get("MEO")!.push(sat.NORAD_CAT_ID);

        let total = 0;
        for (const [k, v] of selected.entries()) total += v.length;
        if (total >= 100) break;
    }

    console.log("Selected satellites:");
    for (const [k, v] of selected.entries()) {
        console.log(`${k}: ${v.length}`);
    }

    const allIds = Array.from(selected.values()).flat();
    fs.writeFileSync('selected_100.json', JSON.stringify(allIds));
    console.log("Written to selected_100.json");
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

main().catch(console.error);
