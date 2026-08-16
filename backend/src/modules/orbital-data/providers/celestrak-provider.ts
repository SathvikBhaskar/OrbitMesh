import { OrbitalData, OrbitalDataProvider } from "../types";

// Parses TLE Epoch (Line 1 columns 19-32) into a JavaScript Date object
function parseTleEpoch(line1: string): Date {
  const epochYearStr = line1.substring(18, 20);
  const epochDaysStr = line1.substring(20, 32);

  let year = parseInt(epochYearStr, 10);
  year = year < 57 ? 2000 + year : 1900 + year; // standard TLE year windowing

  const days = parseFloat(epochDaysStr);
  const date = new Date(Date.UTC(year, 0, 1));
  date.setUTCMilliseconds((days - 1) * 24 * 60 * 60 * 1000);
  return date;
}

export class CelestrakProvider implements OrbitalDataProvider {
  async getByNoradId(noradId: number): Promise<OrbitalData> {
    const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${noradId}&FORMAT=tle`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`CelesTrak API failed with status: ${response.status}`);
    }

    const text = await response.text();
    // A standard TLE from Celestrak GP endpoint usually has 3 lines: Name, Line 1, Line 2.
    // Or it might just return 2 lines if name is not requested, but by default it returns the 3-line format.
    const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    if (lines.length < 2) {
      throw new Error("Invalid response format from CelesTrak");
    }

    let satelliteName = "UNKNOWN";
    let tleLine1 = "";
    let tleLine2 = "";

    if (lines.length === 3) {
      satelliteName = lines[0]!;
      tleLine1 = lines[1]!;
      tleLine2 = lines[2]!;
    } else {
      tleLine1 = lines[0]!;
      tleLine2 = lines[1]!;
    }

    // Verify it actually returned a TLE
    if (!tleLine1.startsWith("1 ") || !tleLine2.startsWith("2 ")) {
      throw new Error("CelesTrak returned invalid TLE data");
    }

    const tleEpoch = parseTleEpoch(tleLine1);

    return {
      noradId,
      satelliteName,
      tleLine1,
      tleLine2,
      tleEpoch,
      source: "CELESTRAK",
    };
  }
}
