import * as satellite from 'satellite.js';

const line1 = "1 25544U 98067A   23277.51352468  .00015509  00000-0  28258-3 0  9997";
const line2 = "2 25544  51.6400 320.1234 0000000   0.0000   0.0000 15.50000000    00";

const satrec = satellite.twoline2satrec(line1, line2);

const start = new Date();
const endMs = start.getTime() + 24 * 3600 * 1000;
const stepMs = 60 * 1000;

const stations = [
    { id: 'stn-0', lat: 0.61, lon: -1.22, alt: 0 },
    { id: 'stn-1', lat: 0.87, lon: 0.12, alt: 0 },
    { id: 'stn-2', lat: -0.5, lon: 2.1, alt: 0 }
];

let totalCount = 0;

for (const stn of stations) {
    let aos = 0;
    let inWindow = false;

    for (let t = start.getTime(); t <= endMs; t += stepMs) {
        const d = new Date(t);
        const positionAndVelocity = satellite.propagate(satrec, d);
        if (!positionAndVelocity.position || typeof positionAndVelocity.position === 'boolean') {
            continue;
        }

        const gmst = satellite.gstime(d);
        const positionEcf = satellite.eciToEcf(positionAndVelocity.position as satellite.EciVec3<number>, gmst);
        
        const observerGd = { longitude: stn.lon, latitude: stn.lat, height: stn.alt };
        const lookAngles = satellite.ecfToLookAngles(observerGd, positionEcf);

        if (lookAngles.elevation >= 0.174533) {
            if (!inWindow) {
                inWindow = true;
                aos = t;
            }
        } else {
            if (inWindow) {
                inWindow = false;
                totalCount++;
                console.log(`Window found for ${stn.id}: duration ${(t - aos) / 1000}s`);
            }
        }
    }
}

console.log("Total windows:", totalCount);
