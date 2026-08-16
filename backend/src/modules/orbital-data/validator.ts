import { twoline2satrec } from "satellite.js";

export function validateTle(line1: string, line2: string, expectedNoradId: number): void {
  // Test A & B: Both lines exist and are non-empty
  if (!line1 || line1.trim() === "") {
    throw new Error("TLE line 1 is missing or empty");
  }
  if (!line2 || line2.trim() === "") {
    throw new Error("TLE line 2 is missing or empty");
  }

  // Check lines length (basic format)
  if (line1.length < 68 || line2.length < 68) {
     throw new Error("TLE lines must be at least 68 characters");
  }

  // Test D: The embedded catalog number agrees with our satellite
  const noradIdStr1 = line1.substring(2, 7).trim();
  const noradIdStr2 = line2.substring(2, 7).trim();
  
  const parsedNorad1 = parseInt(noradIdStr1, 10);
  const parsedNorad2 = parseInt(noradIdStr2, 10);

  if (parsedNorad1 !== expectedNoradId || parsedNorad2 !== expectedNoradId) {
    throw new Error(`NORAD ID mismatch: expected ${expectedNoradId}, found ${parsedNorad1} / ${parsedNorad2}`);
  }

  // Test C: The TLE can be parsed by satellite.js
  let satrec: any;
  try {
    satrec = twoline2satrec(line1, line2);
  } catch (err: any) {
    throw new Error(`Failed to parse TLE with satellite.js: ${err.message}`);
  }

  if (!satrec || satrec.error !== 0) {
    throw new Error(`satellite.js rejected TLE, error code: ${satrec?.error}`);
  }
}
