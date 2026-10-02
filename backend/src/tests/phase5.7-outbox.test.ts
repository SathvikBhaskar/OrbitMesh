import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import {
  users,
  satellites,
  groundStations,
  satelliteOrbitalData,
  contactWindows,
  missionTasks,
  reservations,
  dispatchAttempts,
  outboundDispatchMessages,
} from "../db/schema";
import { outboxService } from "../modules/outbox/outbox.service";

describe("Phase 5.7: Workstream 5.7.1 — Transactional Outbox & Durable Delivery", () => {
  let satId: string;
  let gsId: string;
  let odId: string;

  const epochBase = Date.now() + 700000000;
  let contactCounter = 0;

  beforeAll(async () => {
    // 1. Setup base satellite, ground station, orbital data
    const [sat] = await db
      .insert(satellites)
      .values({
        noradId: 67001,
        name: "Outbox-Sat-1",
        status: "ACTIVE",
      })
      .returning();
    satId = sat.id;

    const [od] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: satId,
        source: "CELESTRAK",
        tleLine1: "1 67001U 26001A   26270.00000000  .00001000  00000-0  10000-3 0  9991",
        tleLine2: "2 67001  97.5000 120.0000 0010000  45.0000 315.0000 15.10000000000018",
        tleEpoch: new Date(),
        receivedAt: new Date(),
      })
      .returning();
    odId = od.id;

    const [gs] = await db
      .insert(groundStations)
      .values({
        code: `GS-OUTBOX-${Date.now() % 10000}`,
        name: "Outbox-GS-Station",
        latitude: -15.0,
        longitude: 40.0,
        altitudeM: 100,
        status: "AVAILABLE",
        minimumElevationDeg: 5,
        supportedFrequencyBands: ["S_BAND", "X_BAND"],
        maxConcurrentContacts: 2,
        maxDataRateMbps: 300,
      })
      .returning();
    gsId = gs.id;
  });

  afterAll(async () => {
    await db.delete(outboundDispatchMessages);
    await db.delete(dispatchAttempts);
    await db.delete(reservations);
    await db.delete(contactWindows);
    await db.delete(missionTasks);
    await db.delete(satelliteOrbitalData).where(eq(satelliteOrbitalData.satelliteId, satId));
    await db.delete(satellites).where(eq(satellites.id, satId));
    await db.delete(groundStations).where(eq(groundStations.id, gsId));
  });

  async function seedTestReservation(suffix: string) {
    contactCounter++;
    const startMs = epochBase + contactCounter * 3600000;
    const endMs = startMs + 600000;

    const [task] = await db
      .insert(missionTasks)
      .values({
        satelliteId: satId,
        name: `Task-5.7-${suffix}-${contactCounter}`,
        priority: 1,
        durationSeconds: 600,
        deadline: new Date(startMs + 86400000),
        status: "SCHEDULED",
        targetBytes: 1000000000,
        fulfilledBytes: 0,
        remainingBytes: 1000000000,
      })
      .returning();

    const [cw] = await db
      .insert(contactWindows)
      .values({
        satelliteId: satId,
        groundStationId: gsId,
        orbitalDataId: odId,
        aos: new Date(startMs),
        los: new Date(endMs),
        durationSeconds: 600,
        maxElevationDeg: 45,
      })
      .returning();

    const [res] = await db
      .insert(reservations)
      .values({
        missionTaskId: task.id,
        contactWindowId: cw.id,
        satelliteId: satId,
        groundStationId: gsId,
        windowAos: new Date(startMs),
        windowLos: new Date(endMs),
        allocatedStart: new Date(startMs),
        allocatedEnd: new Date(endMs),
        taskDurationSeconds: 600,
        status: "CONFIRMED",
        executionState: "SCHEDULED",
        bytesTransferred: 0,
      })
      .returning();

    return { task, cw, res };
  }

  // =========================================================================
  // WORKSTREAM 5.7.1 ACCEPTANCE TESTS
  // =========================================================================

  it("1. Scenario A: Crash / rollback before DB commit — zero entity creation and no state mutation", async () => {
    const { res } = await seedTestReservation("A-Rollback");

    // Attempt an atomic transition that forces an error before commit
    await expect(
      db.transaction(async (tx) => {
        // Step 1: transition reservation
        await tx
          .update(reservations)
          .set({ executionState: "EXECUTION_READY" })
          .where(eq(reservations.id, res.id));

        // Step 2: insert attempt
        await tx.insert(dispatchAttempts).values({
          reservationId: res.id,
          dispatchId: "disp-fail-commit",
          attemptNumber: 1,
          state: "PREPARED",
        });

        // Step 3: Simulated crash / exception before commit
        throw new Error("SIMULATED_PROCESS_CRASH_BEFORE_COMMIT");
      })
    ).rejects.toThrow("SIMULATED_PROCESS_CRASH_BEFORE_COMMIT");

    // Invariant: Reservation remains SCHEDULED, no dispatch attempt exists, no outbox message exists
    const [checkRes] = await db.select().from(reservations).where(eq(reservations.id, res.id));
    expect(checkRes.executionState).toBe("SCHEDULED");
    expect(checkRes.activeDispatchId).toBeNull();

    const attempts = await db.select().from(dispatchAttempts).where(eq(dispatchAttempts.reservationId, res.id));
    expect(attempts.length).toBe(0);

    const outboxMsgs = await db.select().from(outboundDispatchMessages).where(eq(outboundDispatchMessages.reservationId, res.id));
    expect(outboxMsgs.length).toBe(0);
  });

  it("2. Scenario B: Crash after DB commit / before delivery — outbox survives in PENDING and is recovered", async () => {
    const { res } = await seedTestReservation("B-Survive");

    // Atomic transaction succeeds
    const result = await outboxService.transitionToExecutionReadyWithOutbox(
      res.id,
      "provider-alpha",
      { payload: { freqHz: 2200000000 } }
    );

    expect(result.dispatchId).toBeDefined();
    expect(result.messageId).toBeDefined();

    // Verify reservation is EXECUTION_READY
    const [checkRes] = await db.select().from(reservations).where(eq(reservations.id, res.id));
    expect(checkRes.executionState).toBe("EXECUTION_READY");
    expect(checkRes.activeDispatchId).toBe(result.dispatchId);

    // Verify dispatch attempt is PREPARED
    const [attempt] = await db.select().from(dispatchAttempts).where(eq(dispatchAttempts.dispatchId, result.dispatchId));
    expect(attempt).toBeDefined();
    expect(attempt.state).toBe("PREPARED");

    // Verify outbox message is PENDING
    const [outboxMsg] = await db.select().from(outboundDispatchMessages).where(eq(outboundDispatchMessages.messageId, result.messageId));
    expect(outboxMsg).toBeDefined();
    expect(outboxMsg.status).toBe("PENDING");

    // Worker recovery: Worker starts up, queries pending messages, and delivers message successfully
    const pendingList = await outboxService.fetchPendingOutboxMessages(10);
    const targetMsg = pendingList.find((m) => m.messageId === result.messageId);
    expect(targetMsg).toBeDefined();

    let providerReceived = false;
    const deliveryResult = await outboxService.deliverOutboxMessage(result.messageId, async (msg) => {
      providerReceived = true;
      expect(msg.dispatchId).toBe(result.dispatchId);
      expect((msg.payload as any).freqHz).toBe(2200000000);
    });

    expect(deliveryResult.delivered).toBe(true);
    expect(deliveryResult.status).toBe("DELIVERED");
    expect(providerReceived).toBe(true);

    const [deliveredMsg] = await db.select().from(outboundDispatchMessages).where(eq(outboundDispatchMessages.messageId, result.messageId));
    expect(deliveredMsg.status).toBe("DELIVERED");
    expect(deliveredMsg.sentAt).not.toBeNull();
  });

  it("3. Scenario C: Provider timeout after accepted stage — worker retries with identical dispatchId and idempotencyKey", async () => {
    const { res } = await seedTestReservation("C-TimeoutRetry");

    const result = await outboxService.transitionToExecutionReadyWithOutbox(
      res.id,
      "provider-beta",
      { payload: { passBand: "S_BAND" } }
    );

    let callCount = 0;
    const externalProviderRegistry = new Map<string, string>();

    // Simulated provider sender:
    // First call: provider records the dispatch but connection drops before ACK returns
    // Second call: provider receives identical dispatchId and returns idempotent ACK
    const mockProviderSender = async (msg: any) => {
      callCount++;
      if (callCount === 1) {
        // Provider staged pass internally
        externalProviderRegistry.set(msg.dispatchId, "STAGED_AT_PROVIDER");
        throw new Error("HTTP_GATEWAY_TIMEOUT");
      }
      // Second call: provider verifies existing dispatchId
      if (externalProviderRegistry.has(msg.dispatchId)) {
        return; // Idempotent ACK returned!
      }
      throw new Error("UNEXPECTED_CALL");
    };

    // First delivery attempt fails with timeout
    const firstDelivery = await outboxService.deliverOutboxMessage(result.messageId, mockProviderSender);
    expect(firstDelivery.delivered).toBe(false);
    expect(firstDelivery.status).toBe("RETRY");
    expect(firstDelivery.error).toBe("HTTP_GATEWAY_TIMEOUT");

    // Message is now in RETRY status with backoff
    const [retryMsg] = await db.select().from(outboundDispatchMessages).where(eq(outboundDispatchMessages.messageId, result.messageId));
    expect(retryMsg.status).toBe("RETRY");
    expect(retryMsg.attemptCount).toBe(1);

    // Force nextAttemptAt to past to simulate backoff elapsed
    await db
      .update(outboundDispatchMessages)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(outboundDispatchMessages.messageId, result.messageId));

    // Second delivery attempt succeeds idempotently
    const secondDelivery = await outboxService.deliverOutboxMessage(result.messageId, mockProviderSender);
    expect(secondDelivery.delivered).toBe(true);
    expect(secondDelivery.status).toBe("DELIVERED");
    expect(callCount).toBe(2);

    // Verify identical dispatchId was preserved across both deliveries
    const [finalMsg] = await db.select().from(outboundDispatchMessages).where(eq(outboundDispatchMessages.messageId, result.messageId));
    expect(finalMsg.dispatchId).toBe(result.dispatchId);
    expect(finalMsg.attemptCount).toBe(2);
  });

  it("4. Invariant Gate: DLQ status indicates delivery exhaustion, NOT physical execution failure", async () => {
    const { res } = await seedTestReservation("DLQ-Safety");

    const result = await outboxService.transitionToExecutionReadyWithOutbox(
      res.id,
      "provider-gamma"
    );

    // Update maxAttempts to 2 for quick DLQ test
    await db
      .update(outboundDispatchMessages)
      .set({ maxAttempts: 2 })
      .where(eq(outboundDispatchMessages.messageId, result.messageId));

    const failingSender = async () => {
      throw new Error("NETWORK_UNREACHABLE");
    };

    // Attempt 1 -> RETRY
    const att1 = await outboxService.deliverOutboxMessage(result.messageId, failingSender);
    expect(att1.status).toBe("RETRY");

    // Reset backoff
    await db
      .update(outboundDispatchMessages)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(outboundDispatchMessages.messageId, result.messageId));

    // Attempt 2 -> DLQ (maxAttempts reached)
    const att2 = await outboxService.deliverOutboxMessage(result.messageId, failingSender);
    expect(att2.status).toBe("DLQ");

    // Verify outbox message is in DLQ
    const [dlqMsg] = await db.select().from(outboundDispatchMessages).where(eq(outboundDispatchMessages.messageId, result.messageId));
    expect(dlqMsg.status).toBe("DLQ");
    expect(dlqMsg.lastError).toContain("NETWORK_UNREACHABLE");

    // CARDINAL INVARIANT: Reservation execution state is NOT failed!
    const [checkRes] = await db.select().from(reservations).where(eq(reservations.id, res.id));
    expect(checkRes.executionState).toBe("EXECUTION_READY");
    expect(checkRes.executionState).not.toBe("FAILED");
  });
});
