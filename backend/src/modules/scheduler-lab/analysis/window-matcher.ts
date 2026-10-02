import { LabContactWindow, MatchedWindow, WindowMatchResult, WindowClassification } from "../impact-types";

function getMs(dateOrStr: string | Date): number {
  return new Date(dateOrStr).getTime();
}

function calculateOverlap(w0: LabContactWindow, w1: LabContactWindow): number {
  const s0 = getMs(w0.aos);
  const e0 = getMs(w0.los);
  const s1 = getMs(w1.aos);
  const e1 = getMs(w1.los);

  const start = Math.max(s0, s1);
  const end = Math.min(e0, e1);

  if (start >= end) return 0; // No overlap

  const overlapDuration = end - start;
  const unionDuration = Math.max(e0, e1) - Math.min(s0, s1);

  if (unionDuration === 0) return 1.0;
  return overlapDuration / unionDuration;
}

export class WindowMatcher {
  
  /**
   * Performs exact maximum-weight bipartite matching using DP.
   * Because both W0 and W1 are sets of disjoint intervals on a 1D timeline,
   * crossing matches are mathematically impossible. Thus, max-weight matching
   * reduces to monotonic sequence alignment (O(N*M)).
   */
  public matchWindows(W0: LabContactWindow[], W1: LabContactWindow[]): WindowMatchResult {
    // 1. Group by (satelliteId, groundStationId)
    const groups0 = this.groupByTarget(W0);
    const groups1 = this.groupByTarget(W1);

    const allKeys = new Set([...groups0.keys(), ...groups1.keys()]);

    let allMatches: MatchedWindow[] = [];
    
    for (const key of allKeys) {
      const g0 = groups0.get(key) || [];
      const g1 = groups1.get(key) || [];

      // Sort by AOS
      g0.sort((a, b) => getMs(a.aos) - getMs(b.aos));
      g1.sort((a, b) => getMs(a.aos) - getMs(b.aos));

      const matches = this.matchGroupDP(g0, g1);
      allMatches.push(...matches);
    }

    // 2. Post-process to flag split/merge based on multi-candidate overlaps
    this.flagSplitsAndMerges(allMatches, W0, W1);

    // 3. Compute metrics (CWF, WDR, WAR, shifts)
    return this.computeMetrics(allMatches, W0.length, W1.length);
  }

  private groupByTarget(windows: LabContactWindow[]): Map<string, LabContactWindow[]> {
    const map = new Map<string, LabContactWindow[]>();
    for (const w of windows) {
      const key = `${w.satelliteId}_${w.ground_station_id}`;
      const arr = map.get(key) || [];
      arr.push(w);
      map.set(key, arr);
    }
    return map;
  }

  private matchGroupDP(g0: LabContactWindow[], g1: LabContactWindow[]): MatchedWindow[] {
    const n = g0.length;
    const m = g1.length;
    
    // dp[i][j] stores the max weight matching using prefixes g0[0..i-1] and g1[0..j-1]
    const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
    // choices: 1 = match(i-1, j-1), 2 = skip W0 (i-1), 3 = skip W1 (j-1)
    const choice: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));

    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const overlap = calculateOverlap(g0[i - 1], g1[j - 1]);
        
        let best = dp[i - 1][j]; // skip W0
        let c = 2;

        if (dp[i][j - 1] > best) { // skip W1
          best = dp[i][j - 1];
          c = 3;
        }

        if (overlap > 0) {
          const matchScore = dp[i - 1][j - 1] + overlap;
          if (matchScore >= best) { // Bias towards matching if score is same or better
            best = matchScore;
            c = 1;
          }
        }

        dp[i][j] = best;
        choice[i][j] = c;
      }
    }

    // Backtrack to extract the actual matches
    let i = n;
    let j = m;
    const matches: MatchedWindow[] = [];
    const matched0 = new Set<string>();
    const matched1 = new Set<string>();

    while (i > 0 && j > 0) {
      if (choice[i][j] === 1) {
        const w0 = g0[i - 1];
        const w1 = g1[j - 1];
        const overlap = calculateOverlap(w0, w1);
        
        const classification = this.classifyMatch(w0, w1);
        
        matches.push({
          w0,
          w1,
          overlapFraction: overlap,
          classification,
          isSplit: false, // will be updated later
          isMerge: false  // will be updated later
        });

        matched0.add(w0.id);
        matched1.add(w1.id);
        i--;
        j--;
      } else if (choice[i][j] === 2) {
        i--;
      } else {
        j--;
      }
    }

    // Add unmatched as APPEARED / DISAPPEARED
    for (const w0 of g0) {
      if (!matched0.has(w0.id)) {
        matches.push({
          w0, w1: null, overlapFraction: 0, classification: "DISAPPEARED", isSplit: false, isMerge: false
        });
      }
    }
    for (const w1 of g1) {
      if (!matched1.has(w1.id)) {
        matches.push({
          w0: null, w1, overlapFraction: 0, classification: "APPEARED", isSplit: false, isMerge: false
        });
      }
    }

    return matches;
  }

  private classifyMatch(w0: LabContactWindow, w1: LabContactWindow): WindowClassification {
    const s0 = getMs(w0.aos);
    const e0 = getMs(w0.los);
    const s1 = getMs(w1.aos);
    const e1 = getMs(w1.los);

    const shiftAos = Math.abs(s1 - s0);
    const shiftLos = Math.abs(e1 - e0);
    const dur0 = e0 - s0;
    const dur1 = e1 - s1;
    const durShift = Math.abs(dur1 - dur0);

    // CHANGED thresholds (e.g. > 10 seconds shift in any bound or duration)
    const THRESHOLD = 10000; 
    
    if (shiftAos > THRESHOLD || shiftLos > THRESHOLD || durShift > THRESHOLD) {
      return "CHANGED";
    }
    return "UNCHANGED";
  }

  private flagSplitsAndMerges(matches: MatchedWindow[], W0: LabContactWindow[], W1: LabContactWindow[]) {
    // A split happens when a single W0 window overlaps with multiple W1 windows.
    // A merge happens when multiple W0 windows overlap with a single W1 window.
    // We determine overlaps independent of the 1-to-1 matching to accurately flag the neighborhoods.

    const w0Overlaps = new Map<string, number>();
    const w1Overlaps = new Map<string, number>();

    // To avoid O(N^2) globally, we can just check within the same station+satellite group, 
    // but building an interval tree or doing brute force inside the groups is fine.
    const g0 = this.groupByTarget(W0);
    const g1 = this.groupByTarget(W1);

    for (const [key, windows0] of g0.entries()) {
      const windows1 = g1.get(key) || [];
      for (const w0 of windows0) {
        for (const w1 of windows1) {
          if (calculateOverlap(w0, w1) > 0) {
            w0Overlaps.set(w0.id, (w0Overlaps.get(w0.id) || 0) + 1);
            w1Overlaps.set(w1.id, (w1Overlaps.get(w1.id) || 0) + 1);
          }
        }
      }
    }

    for (const match of matches) {
      if (match.w0) {
        if ((w0Overlaps.get(match.w0.id) || 0) > 1) {
          match.isSplit = true;
        }
      }
      if (match.w1) {
        if ((w1Overlaps.get(match.w1.id) || 0) > 1) {
          match.isMerge = true;
        }
      }
    }
  }

  private computeMetrics(matches: MatchedWindow[], totalW0: number, totalW1: number): WindowMatchResult {
    let changed = 0;
    let unchanged = 0;
    let disappeared = 0;
    let appeared = 0;
    
    let sumAosShift = 0;
    let sumLosShift = 0;
    let sumDurDelta = 0;
    let countMatched = 0;

    for (const m of matches) {
      if (m.classification === "UNCHANGED") unchanged++;
      if (m.classification === "CHANGED") changed++;
      if (m.classification === "DISAPPEARED") disappeared++;
      if (m.classification === "APPEARED") appeared++;

      if (m.w0 && m.w1) {
        sumAosShift += Math.abs(getMs(m.w1.aos) - getMs(m.w0.aos));
        sumLosShift += Math.abs(getMs(m.w1.los) - getMs(m.w0.los));
        const dur0 = getMs(m.w0.los) - getMs(m.w0.aos);
        const dur1 = getMs(m.w1.los) - getMs(m.w1.aos);
        sumDurDelta += Math.abs((dur1 - dur0) / dur0);
        countMatched++;
      }
    }

    return {
      matches,
      cwf: totalW0 > 0 ? (changed + disappeared) / totalW0 : 0,
      wdr: totalW0 > 0 ? disappeared / totalW0 : 0,
      war: totalW0 > 0 ? appeared / totalW0 : 0,
      meanAosShiftMs: countMatched > 0 ? sumAosShift / countMatched : 0,
      meanLosShiftMs: countMatched > 0 ? sumLosShift / countMatched : 0,
      meanRelativeDurationDelta: countMatched > 0 ? sumDurDelta / countMatched : 0,
      totalW0,
      totalW1
    };
  }
}
