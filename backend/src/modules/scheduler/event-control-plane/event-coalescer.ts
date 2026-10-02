/**
 * OrbitMesh Phase 5.3 - Event Coalescer & Subsumption Engine
 *
 * Implements:
 * 1. Outage interval subsumption:
 *    [t0, t0+30m] + [t0, t0+60m] on Station A -> merges into [t0, t0+60m]
 *    Earlier event marked SUPERSEDED.
 * 2. Duplicate task preemption consolidation:
 *    Multiple preemption requests for same taskId within batch window coalesce.
 */

import { OrchestratedEventInput } from "./control-plane.types";

export interface CoalescedBatch {
  activeEvents: OrchestratedEventInput[];
  supersededEvents: {
    event: OrchestratedEventInput;
    supersededBy: string; // idempotencyKey of superseding event
    reason: string;
  }[];
}

export class EventCoalescer {
  /**
   * Coalesces and subsumes a batch of operational events according to domain rules.
   */
  public coalesceEvents(rawEvents: OrchestratedEventInput[]): CoalescedBatch {
    if (rawEvents.length <= 1) {
      return { activeEvents: [...rawEvents], supersededEvents: [] };
    }

    const superseded: CoalescedBatch["supersededEvents"] = [];
    const activeOutages = new Map<string, OrchestratedEventInput>(); // gsId -> event
    const activePreemptions = new Map<string, OrchestratedEventInput>(); // taskId -> event
    const others: OrchestratedEventInput[] = [];

    for (const evt of rawEvents) {
      if (evt.eventType === "STATION_OUTAGE") {
        const gsId = evt.payload.groundStationId;
        const current = activeOutages.get(gsId);

        if (!current) {
          activeOutages.set(gsId, evt);
        } else {
          // Compare intervals
          const curStart = new Date(current.payload.outageStart).getTime();
          const curEnd = new Date(current.payload.outageEnd).getTime();
          const newStart = new Date(evt.payload.outageStart).getTime();
          const newEnd = new Date(evt.payload.outageEnd).getTime();

          // Check if intervals overlap or abut
          if (newStart <= curEnd && newEnd >= curStart) {
            // Overlapping/subsumable interval!
            const mergedStart = new Date(Math.min(curStart, newStart));
            const mergedEnd = new Date(Math.max(curEnd, newEnd));

            // Determine which event supersedes which
            if (newEnd >= curEnd && newStart <= curStart) {
              // evt completely subsumes current
              superseded.push({
                event: current,
                supersededBy: evt.idempotencyKey,
                reason: "OUTAGE_INTERVAL_EXPANDED",
              });
              evt.payload.outageStart = mergedStart;
              evt.payload.outageEnd = mergedEnd;
              activeOutages.set(gsId, evt);
            } else {
              // current subsumes evt or merges into current
              superseded.push({
                event: evt,
                supersededBy: current.idempotencyKey,
                reason: "OUTAGE_INTERVAL_EXPANDED",
              });
              current.payload.outageStart = mergedStart;
              current.payload.outageEnd = mergedEnd;
            }
          } else {
            // Non-overlapping separate outages on same station
            others.push(evt);
          }
        }
      } else if (evt.eventType === "TASK_PREEMPTION") {
        const taskId = evt.payload.taskId;
        const existing = activePreemptions.get(taskId);
        if (!existing) {
          activePreemptions.set(taskId, evt);
        } else {
          // Duplicate preemption request for same task in same batch
          superseded.push({
            event: existing,
            supersededBy: evt.idempotencyKey,
            reason: "DUPLICATE_TASK_PREEMPTION_IN_BATCH",
          });
          activePreemptions.set(taskId, evt);
        }
      } else {
        others.push(evt);
      }
    }

    const activeEvents: OrchestratedEventInput[] = [
      ...Array.from(activeOutages.values()),
      ...Array.from(activePreemptions.values()),
      ...others,
    ];

    return {
      activeEvents,
      supersededEvents: superseded,
    };
  }
}
