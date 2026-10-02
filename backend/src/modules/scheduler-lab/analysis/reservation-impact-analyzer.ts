import { LabReservation, LabContactWindow, ImpactResult } from "../impact-types";

export class ReservationImpactAnalyzer {
  
  public analyzeImpact(S0: LabReservation[], W1: LabContactWindow[], updatedSatellites: string[]): ImpactResult {
    // 1. Map W1 for fast lookup
    const w1Map = new Map<string, LabContactWindow[]>();
    for (const w of W1) {
      const key = `${w.satelliteId}_${w.ground_station_id}`;
      const arr = w1Map.get(key) || [];
      arr.push(w);
      w1Map.set(key, arr);
    }

    let sreCount = 0;
    const invalidatedReservationIds: string[] = [];
    const affectedTaskIds = new Set<string>();
    const slideableReservationIds: string[] = [];
    const updatedSatSet = new Set(updatedSatellites);

    let splitContaminationCount = 0;

    for (const r of S0) {
      if (!r.allocated_start || !r.allocated_end) continue;
      
      const isExposed = updatedSatSet.has(r.satelliteId);
      if (isExposed) {
        sreCount++;
      } else {
        continue; // Unexposed reservations cannot be invalidated by this update
      }

      const rStart = new Date(r.allocated_start).getTime();
      const rEnd = new Date(r.allocated_end).getTime();
      const key = `${r.satelliteId}_${r.ground_station_id}`;
      const candidates = w1Map.get(key) || [];

      // A reservation is VALID if there exists at least ONE window in W1 that fully contains the allocation
      let isValid = false;
      let slideable = false;
      let containedCount = 0;

      for (const w1 of candidates) {
        const wStart = new Date(w1.aos).getTime();
        const wEnd = new Date(w1.los).getTime();

        const fullyContains = rStart >= wStart && rEnd <= wEnd;
        if (fullyContains) {
          isValid = true;
          containedCount++;
          // We break early? No, let's keep checking to detect splits/contamination 
          // (though technically if one contains it, it's valid).
        }
        
        // SLIDEABLE check: does the reservation duration fit anywhere in this window?
        // (This is for Strategy 3 / future extension)
        const rDuration = rEnd - rStart;
        const wDuration = wEnd - wStart;
        if (rDuration <= wDuration) {
          slideable = true;
        }
      }

      // If it straddles multiple windows (split contamination), it might not be fully contained by any single window
      // meaning isValid will be false, which is correct (a task cannot span a physical loss of signal).
      if (!isValid) {
        invalidatedReservationIds.push(r.id);
        if (r.task_id) {
          affectedTaskIds.add(r.task_id);
        }
        
        // Let's see if it partially intersected multiple W1 windows (split contamination)
        let intersectionCount = 0;
        for (const w1 of candidates) {
          const wStart = new Date(w1.aos).getTime();
          const wEnd = new Date(w1.los).getTime();
          if (Math.max(rStart, wStart) < Math.min(rEnd, wEnd)) {
            intersectionCount++;
          }
        }
        if (intersectionCount > 1) {
          splitContaminationCount++;
        }
        
        if (slideable) {
          slideableReservationIds.push(r.id);
        }
      }
    }

    const totalS0 = S0.length;
    const sre = totalS0 > 0 ? sreCount / totalS0 : 0;
    const ir = totalS0 > 0 ? invalidatedReservationIds.length / totalS0 : 0;
    
    // SPR: Split Contamination Rate (portion of invalidated due to splits)
    const spr = invalidatedReservationIds.length > 0 ? splitContaminationCount / invalidatedReservationIds.length : 0;
    
    // ATF: Affected Task Fraction
    // We would need the total number of tasks in the schedule to compute ATF correctly, 
    // but we can compute it relative to the number of scheduled tasks (assuming 1-to-1 task-reservation for now)
    const scheduledTasks = new Set(S0.map(r => r.task_id).filter(id => id));
    const atf = scheduledTasks.size > 0 ? affectedTaskIds.size / scheduledTasks.size : 0;

    // SlF: Slideable Fraction
    const slf = invalidatedReservationIds.length > 0 ? slideableReservationIds.length / invalidatedReservationIds.length : 0;

    // SC: Schedule Contraction
    // Represents sum duration of invalidated reservations / sum duration of all reservations
    const sumAll = S0.reduce((acc, r) => acc + (new Date(r.allocated_end!).getTime() - new Date(r.allocated_start!).getTime()), 0);
    const sumInvalid = S0.filter(r => invalidatedReservationIds.includes(r.id))
      .reduce((acc, r) => acc + (new Date(r.allocated_end!).getTime() - new Date(r.allocated_start!).getTime()), 0);
    
    const sc = sumAll > 0 ? sumInvalid / sumAll : 0;

    return {
      sre,
      ir,
      spr,
      atf,
      sc,
      slf,
      invalidatedReservationIds,
      affectedTaskIds: Array.from(affectedTaskIds),
      slideableReservationIds
    };
  }
}
