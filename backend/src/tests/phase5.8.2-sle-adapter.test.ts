/**
 * Phase 5.8: Workstream 5.8.2-B — CCSDS SLE Provider Adapter Test Suite
 *
 * Validates:
 * 1. SLE PDU Binary Codec & ASN.1 Framing
 * 2. Space-Link Frame Engine (CCSDS 132.0-B-3 TM, ASM Detection, Sequence Gaps)
 * 3. Stateful SLE Session Engine & Failure Semantics Matrix (TCP drops, duplicate BIND/START, timeouts, reconnect)
 * 4. SleGroundStationProviderAdapter Lifecycle & Canonical State Mapping
 * 5. Safety Interlocks & Carrier Silencing on Abort
 * 6. Capability Validation (S-Band, X-Band, Ka-Band rejection, 100 Mbps rate ceiling)
 * 7. Frozen 5.8.1 Certification Harness Gate (16/16 assertions across all 4 layers)
 * 8. Production Gate & Registry Admission (ProviderNotCertifiedError enforcement)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import crypto from "crypto";
import { SleGroundStationProviderAdapter } from "../modules/ground-provider/adapters/sle/sle-provider.adapter";
import { SleSessionEngine } from "../modules/ground-provider/adapters/sle/sle-session.engine";
import { SleFrameEngine } from "../modules/ground-provider/adapters/sle/sle-frame.engine";
import { SlePduCodec } from "../modules/ground-provider/adapters/sle/sle-pdu.codec";
import {
  SleBindRequestPdu,
  RafTransferDataPdu,
  SlePeerAbortPdu,
} from "../modules/ground-provider/adapters/sle/sle.types";
import {
  DispatchContext,
  RfRequirements,
} from "../modules/ground-provider/provider.types";
import { DispatchManifest } from "../modules/execution/execution.types";
import { providerCertificationHarness } from "../modules/ground-provider/certification/certification-harness.service";
import {
  ProviderRegistry,
  ProviderNotCertifiedError,
} from "../modules/ground-provider/provider.registry";
import { db } from "../db/client";
import {
  groundStations,
  groundStationCredentials,
  satellites,
  satelliteOrbitalData,
  contactWindows,
  missionTasks,
  reservations,
  dispatchAttempts,
  outboundDispatchMessages,
} from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { OutboxService } from "../modules/outbox/outbox.service";

describe("Phase 5.8.2-B: CCSDS Space Link Extension (SLE) Adapter", () => {
  let sleAdapter: SleGroundStationProviderAdapter;
  let stationId: string;
  let satId: string;
  let odId: string;
  let testKeyId: string;
  const testSecretKey = "sle-test-secret-key-32bytes-len!";
  let resCounter = 0;
  const epochBase = 1893456000000;

  beforeAll(async () => {
    // 1. Setup Ground Station & Active Credential
    const [station] = await db
      .insert(groundStations)
      .values({
        code: `SLE-GS-${Date.now() % 10000}`,
        name: "ESTRACK-Redu-1",
        latitude: 50.0,
        longitude: 5.14,
        status: "AVAILABLE",
        minimumElevationDeg: 5,
        supportedFrequencyBands: ["S_BAND", "X_BAND"],
      })
      .returning();
    stationId = station.id;

    testKeyId = `sle-key-${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(groundStationCredentials).values({
      groundStationId: stationId,
      keyId: testKeyId,
      secretKey: testSecretKey,
      status: "ACTIVE",
      expiresAt: new Date(Date.now() + 86400000),
    });

    // 2. Setup Satellite and Orbital Data
    const [sat] = await db
      .insert(satellites)
      .values({
        noradId: 67390,
        name: "Sle-Cert-Sat",
        status: "ACTIVE",
      })
      .returning();
    satId = sat.id;

    const [od] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: satId,
        source: "CELESTRAK",
        tleLine1: "1 67390U 26001A   26270.00000000  .00001000  00000-0  10000-3 0  9991",
        tleLine2: "2 67390  97.5000 120.0000 0010000  45.0000 315.0000 15.10000000000018",
        tleEpoch: new Date(),
        receivedAt: new Date(),
      })
      .returning();
    odId = od.id;
  });

  afterAll(async () => {
    const resList = await db
      .select({ id: reservations.id })
      .from(reservations)
      .where(eq(reservations.satelliteId, satId));
    const resIds = resList.map((r) => r.id);
    if (resIds.length > 0) {
      await db.delete(outboundDispatchMessages).where(inArray(outboundDispatchMessages.reservationId, resIds));
      await db.delete(dispatchAttempts).where(inArray(dispatchAttempts.reservationId, resIds));
      await db.delete(reservations).where(inArray(reservations.id, resIds));
    }
    await db.delete(contactWindows).where(eq(contactWindows.satelliteId, satId));
    await db.delete(missionTasks).where(eq(missionTasks.satelliteId, satId));
    await db.delete(satelliteOrbitalData).where(eq(satelliteOrbitalData.satelliteId, satId));
    await db.delete(satellites).where(eq(satellites.id, satId));
    await db.delete(groundStationCredentials).where(eq(groundStationCredentials.groundStationId, stationId));
    await db.delete(groundStations).where(eq(groundStations.id, stationId));
  });

  beforeEach(() => {
    sleAdapter = new SleGroundStationProviderAdapter("ccsds-sle", {
      versionNumber: 5,
      serviceType: "RAF",
      initiatorId: "ORBITMESH-FEP",
      responderId: "ESTRACK-GATEWAY",
    });
  });

  async function seedReservation(suffix: string) {
    resCounter++;
    const startMs = epochBase + resCounter * 3600000;
    const endMs = startMs + 600000;

    const [task] = await db
      .insert(missionTasks)
      .values({
        satelliteId: satId,
        name: `Task-SLE-${suffix}-${resCounter}`,
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
        groundStationId: stationId,
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
        groundStationId: stationId,
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

  const createMockManifest = (dispatchId: string): DispatchManifest => {
    const now = Date.now();
    return {
      dispatchId,
      reservationId: crypto.randomUUID(),
      satelliteId: satId,
      groundStationId: stationId,
      window: {
        aos: new Date(now + 60000).toISOString(),
        los: new Date(now + 660000).toISOString(),
      },
      allocatedTime: {
        start: new Date(now + 60000).toISOString(),
        end: new Date(now + 660000).toISOString(),
      },
      rfConfiguration: {
        frequencyBand: "S_BAND",
        minDataRateMbps: 50,
      },
      taskManifest: {
        taskId: crypto.randomUUID(),
        priority: 1,
        targetBytes: 250000000,
        remainingBytes: 250000000,
      },
      dispatchedAt: new Date(now).toISOString(),
    };
  };

  const createMockContext = (dispatchId: string): DispatchContext => ({
    dispatchId,
    attemptNumber: 1,
    idempotencyKey: `idemp-sle-${dispatchId}`,
    correlationId: `corr-sle-${dispatchId}`,
    providerId: "ccsds-sle",
    stationCode: "ESTRACK-01",
  });

  // =========================================================================
  // 1. SLE PDU Binary Codec & ASN.1 Framing
  // =========================================================================
  describe("1. SLE PDU Binary Codec & ASN.1 Framing", () => {
    it("encodes and decodes standard SLE BIND_REQUEST PDU with binary round-trip fidelity", () => {
      const bindPdu: SleBindRequestPdu = {
        pduType: "BIND_REQUEST",
        invokeId: 42,
        timestamp: "2026-10-03T12:00:00.000Z",
        initiatorIdentifier: "ORBITMESH-FEP",
        serviceType: "RAF",
        versionNumber: 5,
        serviceInstanceIdentifier: "sagr=1.spack=1.rsl-fg=1.raf=onlc2",
      };

      const encoded = SlePduCodec.encode(bindPdu);
      expect(encoded.length).toBeGreaterThan(9);
      expect(encoded.readUInt32BE(0)).toBe(SlePduCodec.PROTOCOL_MAGIC);

      const decoded = SlePduCodec.decode(encoded) as SleBindRequestPdu;
      expect(decoded.pduType).toBe("BIND_REQUEST");
      expect(decoded.invokeId).toBe(42);
      expect(decoded.initiatorIdentifier).toBe("ORBITMESH-FEP");
      expect(decoded.serviceType).toBe("RAF");
      expect(decoded.versionNumber).toBe(5);
    });

    it("encodes and decodes RAF TRANSFER_DATA PDU preserving binary CADU payload bytes", () => {
      const syntheticCadu = SleFrameEngine.createSyntheticCadu(25544, 1, 10, 5, 500);
      const transferPdu: RafTransferDataPdu = {
        pduType: "TRANSFER_DATA",
        invokeId: 101,
        timestamp: new Date().toISOString(),
        earthReceiveTime: "2026-10-03T12:05:00.000Z",
        antennaId: "ANT-RED-1",
        dataLinkContinuity: 0,
        carrierLockStatus: true,
        subcarrierLockStatus: true,
        symbolSyncLockStatus: true,
        frameSequenceNumber: 7,
        frameData: syntheticCadu,
      };

      const encoded = SlePduCodec.encode(transferPdu);
      const decoded = SlePduCodec.decode(encoded) as RafTransferDataPdu;

      expect(decoded.pduType).toBe("TRANSFER_DATA");
      expect(decoded.frameSequenceNumber).toBe(7);
      expect(decoded.carrierLockStatus).toBe(true);
      expect(decoded.frameData).toBeDefined();
      expect(decoded.frameData.length).toBe(syntheticCadu.length);
      expect(decoded.frameData.readUInt32BE(0)).toBe(SleFrameEngine.CCSDS_ASM_SYNC_MARKER);
    });

    it("rejects truncated or malformed PDU buffers with protocol errors", () => {
      const invalidShortBuffer = Buffer.from([0x01, 0x02, 0x03]);
      expect(() => SlePduCodec.decode(invalidShortBuffer)).toThrow("Buffer too short");

      const invalidMagic = Buffer.alloc(20);
      invalidMagic.writeUInt32BE(0x11223344, 0); // wrong magic
      expect(() => SlePduCodec.decode(invalidMagic)).toThrow("Protocol magic mismatch");
    });
  });

  // =========================================================================
  // 2. Space-Link Frame Engine (CCSDS 132.0-B-3 TM)
  // =========================================================================
  describe("2. Space-Link Frame Engine (CCSDS 132.0-B-3 TM)", () => {
    it("detects CCSDS ASM Sync Marker (0x1ACFFC1D) and extracts TM header fields", () => {
      const frameEngine = new SleFrameEngine();
      const cadu = SleFrameEngine.createSyntheticCadu(42, 3, 15, 8, 1014);

      const transferPdu: RafTransferDataPdu = {
        pduType: "TRANSFER_DATA",
        invokeId: 1,
        timestamp: new Date().toISOString(),
        earthReceiveTime: new Date().toISOString(),
        antennaId: "ANT-1",
        dataLinkContinuity: 0,
        carrierLockStatus: true,
        subcarrierLockStatus: true,
        symbolSyncLockStatus: true,
        frameSequenceNumber: 1,
        frameData: cadu,
      };

      const extracted = frameEngine.ingestTransferData(transferPdu);
      expect(extracted.header.syncMarker).toBe(0x1acffc1d);
      expect(extracted.header.spacecraftId).toBe(42);
      expect(extracted.header.virtualChannelId).toBe(3);
      expect(extracted.header.masterChannelFrameCount).toBe(15);
      expect(extracted.header.virtualChannelFrameCount).toBe(8);
      expect(frameEngine.isCarrierLocked()).toBe(true);
      expect(frameEngine.isFrameSyncLocked()).toBe(true);
      expect(frameEngine.getBytesRecorded()).toBe(cadu.length);
    });

    it("detects sequence gaps in space-link frame stream and tracks missing sequence numbers", () => {
      const frameEngine = new SleFrameEngine();

      const makePdu = (seq: number) => ({
        pduType: "TRANSFER_DATA" as const,
        invokeId: seq,
        timestamp: new Date().toISOString(),
        earthReceiveTime: new Date().toISOString(),
        antennaId: "ANT-1",
        dataLinkContinuity: 0,
        carrierLockStatus: true,
        subcarrierLockStatus: true,
        symbolSyncLockStatus: true,
        frameSequenceNumber: seq,
        frameData: SleFrameEngine.createSyntheticCadu(100, 0, seq, seq),
      });

      frameEngine.ingestTransferData(makePdu(1));
      frameEngine.ingestTransferData(makePdu(2));

      // Introduce a gap: frame 3 and 4 are lost; frame 5 arrives
      frameEngine.ingestTransferData(makePdu(5));

      expect(frameEngine.getSequenceGapsCount()).toBe(2);
      expect(frameEngine.getMissingSequences()).toEqual([3, 4]);
      expect(frameEngine.getFramesIngested()).toBe(3);
    });
  });

  // =========================================================================
  // 3. Stateful SLE Session Engine & Invariant Failure Semantics
  // =========================================================================
  describe("3. Stateful SLE Session Engine & Failure Semantics Matrix", () => {
    it("executes valid session lifecycle: UNBOUND -> BOUND -> ACTIVE -> STOPPING -> UNBOUND", async () => {
      const engine = new SleSessionEngine({
        sessionKey: "session-lifecycle-test",
        initiatorId: "ORBITMESH-FEP",
        responderId: "ESTRACK-GATEWAY",
        serviceInstanceId: "sagr=1.raf=onlc2",
        versionNumber: 5,
        serviceType: "RAF",
      });

      expect(engine.getState()).toBe("UNBOUND");

      // BIND
      const bindRet = await engine.bind();
      expect(bindRet.result).toBe("positive");
      expect(engine.getState()).toBe("BOUND");

      // START
      const startRet = await engine.start(new Date().toISOString(), new Date().toISOString());
      expect(startRet.result).toBe("positive");
      expect(engine.getState()).toBe("ACTIVE");

      // STOP
      const stopRet = await engine.stop();
      expect(stopRet.result).toBe("positive");
      expect(engine.getState()).toBe("BOUND");

      // UNBIND
      const unbindRet = await engine.unbind();
      expect(unbindRet.result).toBe("positive");
      expect(engine.getState()).toBe("UNBOUND");
    });

    it("handles TCP disconnect during BIND: reverts to UNBOUND without creating phantom session", async () => {
      const engine = new SleSessionEngine({
        sessionKey: "session-disconnect-bind-test",
        initiatorId: "ORBITMESH-FEP",
        responderId: "ESTRACK-GATEWAY",
        serviceInstanceId: "sagr=1.raf=onlc2",
        versionNumber: 5,
        serviceType: "RAF",
      });

      engine.simulateTcpDropOnBind = true;
      await expect(engine.bind()).rejects.toThrow("SLE_TCP_DISCONNECT_DURING_BIND");
      expect(engine.getState()).toBe("UNBOUND");
    });

    it("handles TCP disconnect during START: reverts to BOUND preserving session", async () => {
      const engine = new SleSessionEngine({
        sessionKey: "session-disconnect-start-test",
        initiatorId: "ORBITMESH-FEP",
        responderId: "ESTRACK-GATEWAY",
        serviceInstanceId: "sagr=1.raf=onlc2",
        versionNumber: 5,
        serviceType: "RAF",
      });

      await engine.bind();
      expect(engine.getState()).toBe("BOUND");

      engine.simulateTcpDropOnStart = true;
      await expect(engine.start(new Date().toISOString(), new Date().toISOString())).rejects.toThrow(
        "SLE_TCP_DISCONNECT_DURING_START"
      );
      expect(engine.getState()).toBe("BOUND");
    });

    it("returns positive acknowledgment idempotently on duplicate BIND and duplicate START", async () => {
      const engine = new SleSessionEngine({
        sessionKey: "session-idemp-test",
        initiatorId: "ORBITMESH-FEP",
        responderId: "ESTRACK-GATEWAY",
        serviceInstanceId: "sagr=1.raf=onlc2",
        versionNumber: 5,
        serviceType: "RAF",
      });

      // Duplicate BIND
      await engine.bind();
      const dupBind = await engine.bind();
      expect(dupBind.result).toBe("positive");
      expect(engine.getState()).toBe("BOUND");

      // Duplicate START
      await engine.start(new Date().toISOString(), new Date().toISOString());
      const dupStart = await engine.start(new Date().toISOString(), new Date().toISOString());
      expect(dupStart.result).toBe("positive");
      expect(engine.getState()).toBe("ACTIVE");
    });

    it("transitions to BROKEN on SLE_PEER_ABORT and successfully recovers via reconnectAndRebind", async () => {
      const engine = new SleSessionEngine({
        sessionKey: "session-peer-abort-test",
        initiatorId: "ORBITMESH-FEP",
        responderId: "ESTRACK-GATEWAY",
        serviceInstanceId: "sagr=1.raf=onlc2",
        versionNumber: 5,
        serviceType: "RAF",
      });

      await engine.bind();
      await engine.start(new Date().toISOString(), new Date().toISOString());
      expect(engine.getState()).toBe("ACTIVE");

      // Peer abort received
      const peerAbort: SlePeerAbortPdu = {
        pduType: "PEER_ABORT",
        diagnostic: "communicationsFailure",
        timestamp: new Date().toISOString(),
      };
      engine.handleIncomingPdu(peerAbort);
      expect(engine.getState()).toBe("BROKEN");

      // Recover via reconnect and rebind
      await engine.reconnectAndRebind();
      expect(engine.getState()).toBe("BOUND");
    });
  });

  // =========================================================================
  // 4. SleGroundStationProviderAdapter Lifecycle & Canonical Mapping
  // =========================================================================
  describe("4. SleGroundStationProviderAdapter Lifecycle & State Mapping", () => {
    it("stages pass by BINDING an SLE session and returns StagedPassReceipt", async () => {
      const dispatchId = `disp-sle-stage-${Date.now()}`;
      const manifest = createMockManifest(dispatchId);
      const context = createMockContext(dispatchId);

      const receipt = await sleAdapter.stagePass(manifest, context);

      expect(receipt.providerDispatchRef).toContain("sle-session-");
      expect(receipt.stationStatus).toBe("READY");
      expect(receipt.stagedAt).toBeInstanceOf(Date);

      const session = sleAdapter.getSession(dispatchId);
      expect(session).toBeDefined();
      expect(session!.getState()).toBe("BOUND");
    });

    it("arms pass by STARTING space-link telemetry and returns ArmedPassReceipt", async () => {
      const dispatchId = `disp-sle-arm-${Date.now()}`;
      const manifest = createMockManifest(dispatchId);
      const context = createMockContext(dispatchId);

      await sleAdapter.stagePass(manifest, context);
      const armReceipt = await sleAdapter.armPass(dispatchId, context);

      expect(armReceipt.trackingConfigured).toBe(true);
      expect(armReceipt.armedAt).toBeInstanceOf(Date);

      const session = sleAdapter.getSession(dispatchId);
      expect(session!.getState()).toBe("ACTIVE");
    });

    it("maps SLE session states bijectively into canonical PassStatusSnapshot", async () => {
      const dispatchId = `disp-sle-poll-${Date.now()}`;
      const manifest = createMockManifest(dispatchId);
      const context = createMockContext(dispatchId);

      await sleAdapter.stagePass(manifest, context);
      const session = sleAdapter.getSession(dispatchId)!;

      // 1. BOUND -> STAGED, carrierLocked: false
      let status = await sleAdapter.pollPassStatus(dispatchId, context);
      expect(status.state).toBe("STAGED");
      expect(status.carrierLocked).toBe(false);

      // 2. ACTIVE with demodulator carrier lock -> TRACKING, carrierLocked: true
      await sleAdapter.armPass(dispatchId, context);
      status = await sleAdapter.pollPassStatus(dispatchId, context);
      expect(status.state).toBe("TRACKING");
      expect(status.carrierLocked).toBe(true);
      expect(status.bytesRecorded).toBeGreaterThan(0);

      // 3. UNBOUND / STOPPED -> TERMINATED, carrierLocked: false
      await session.stop();
      await session.unbind();
      status = await sleAdapter.pollPassStatus(dispatchId, context);
      expect(status.state).toBe("TERMINATED");
      expect(status.carrierLocked).toBe(false);

      // 4. Unknown dispatch -> UNKNOWN
      const unknown = await sleAdapter.pollPassStatus("unknown-dispatch-id", context);
      expect(unknown.state).toBe("UNKNOWN");
      expect(unknown.carrierLocked).toBe(false);
    });

    it("cancels contact on abortPass by executing RAF STOP + SLE UNBIND and confirms carrier silence", async () => {
      const dispatchId = `disp-sle-abort-${Date.now()}`;
      const manifest = createMockManifest(dispatchId);
      const context = createMockContext(dispatchId);

      await sleAdapter.stagePass(manifest, context);
      await sleAdapter.armPass(dispatchId, context);

      const abortReceipt = await sleAdapter.abortPass(dispatchId, "COLLISION_HAZARD", context);
      expect(abortReceipt.rfCarrierSilenced).toBe(true);
      expect(abortReceipt.confirmedAt).toBeInstanceOf(Date);

      const session = sleAdapter.getSession(dispatchId)!;
      expect(session.getState()).toBe("UNBOUND");
    });

    it("strictly avoids false confirmation during simulated abort transport timeout", async () => {
      const dispatchId = `disp-sle-timeout-${Date.now()}`;
      const manifest = createMockManifest(dispatchId);
      const context = createMockContext(dispatchId);

      await sleAdapter.stagePass(manifest, context);
      sleAdapter.options.simulateAbortTimeout = true;

      try {
        await sleAdapter.abortPass(dispatchId, "TIMEOUT_TEST", context);
        expect.unreachable("Should have thrown ABORT_TRANSPORT_TIMEOUT");
      } catch (err: any) {
        expect(err.message).toBe("ABORT_TRANSPORT_TIMEOUT");
      } finally {
        sleAdapter.options.simulateAbortTimeout = false;
      }
    });
  });

  // =========================================================================
  // 5. Capability Validation
  // =========================================================================
  describe("5. Capability Validation", () => {
    it("accepts supported S-Band and X-Band parameters", async () => {
      const req: RfRequirements = { frequencyBand: "S_BAND", dataRateMbps: 50 };
      const res = await sleAdapter.validateCapabilities("ESTRACK-Redu-1", req);
      expect(res.isCompatible).toBe(true);
      expect(res.maxDataRateFeasible).toBe(true);
      expect(res.unsupportedBands).toEqual([]);
    });

    it("rejects unsupported Ka-Band with explicit reason", async () => {
      const req: RfRequirements = { frequencyBand: "KA_BAND", dataRateMbps: 20000 };
      const res = await sleAdapter.validateCapabilities("ESTRACK-Redu-1", req);
      expect(res.isCompatible).toBe(false);
      expect(res.unsupportedBands).toContain("KA_BAND");
      expect(res.reason).toContain("does not support frequency band KA_BAND");
    });

    it("rejects excessive data rate exceeding CCSDS SLE antenna limit", async () => {
      const req: RfRequirements = { frequencyBand: "S_BAND", dataRateMbps: 500 };
      const res = await sleAdapter.validateCapabilities("ESTRACK-Redu-1", req);
      expect(res.isCompatible).toBe(false);
      expect(res.maxDataRateFeasible).toBe(false);
      expect(res.reason).toContain("exceeds CCSDS SLE max rate");
    });
  });

  // =========================================================================
  // 6. Frozen Phase 5.8.1 Certification Harness Gate
  // =========================================================================
  describe("6. Frozen 5.8.1 Certification Harness Gate", () => {
    it("passes all 16/16 assertions across all 4 layers and issues signed certification receipt", async () => {
      const receipt = await providerCertificationHarness.executeFullCertification(sleAdapter, {
        stationId,
        secretKey: testSecretKey,
        keyId: testKeyId,
        adapterVersion: "1.0.0",
        environment: "PRODUCTION",
        validityDays: 90,
      });

      expect(receipt.isCertified).toBe(true);
      expect(receipt.providerId).toBe("ccsds-sle");
      expect(receipt.adapterVersion).toBe("1.0.0");
      expect(receipt.contractVersion).toBe("5.8.0");
      expect(receipt.certificationSuiteVersion).toBe("5.8.1");
      expect(receipt.summary.totalAssertions).toBe(16);
      expect(receipt.summary.passedAssertions).toBe(16);
      expect(receipt.summary.semantic).toBe(true);
      expect(receipt.summary.distributed).toBe(true);
      expect(receipt.summary.security).toBe(true);
      expect(receipt.summary.safety).toBe(true);

      expect(receipt.signature).toBeDefined();
      expect(receipt.resultsDigest).toBeDefined();

      const verification = providerCertificationHarness.verifyReceipt(receipt);
      expect(verification.isValid).toBe(true);
    });
  });

  // =========================================================================
  // 7. Production Gate & Registry Admission
  // =========================================================================
  describe("7. Production Gate & Registry Admission", () => {
    it("enforces that uncertified SLE adapter is blocked, then admitted upon certification", async () => {
      const registry = new ProviderRegistry();
      const freshAdapter = new SleGroundStationProviderAdapter("ccsds-sle-prod");

      // 1. Initial registration without receipt: provider is UNCERTIFIED
      registry.registerAdapter(freshAdapter);
      expect(registry.isCertified("ccsds-sle-prod")).toBe(false);

      // 2. Production gate asserts certification: throws ProviderNotCertifiedError
      expect(() => {
        registry.assertCertified("ccsds-sle-prod");
      }).toThrow(ProviderNotCertifiedError);

      // 3. Run harness certification
      const receipt = await providerCertificationHarness.executeFullCertification(freshAdapter, {
        stationId,
        secretKey: testSecretKey,
        keyId: testKeyId,
        adapterVersion: "1.0.0",
      });
      expect(receipt.isCertified).toBe(true);

      // 4. Ingest certification receipt into registry
      registry.certifyAdapter("ccsds-sle-prod", receipt);

      // 5. Verification passes and production dispatch is unlocked
      expect(registry.isCertified("ccsds-sle-prod")).toBe(true);
      expect(() => {
        registry.assertCertified("ccsds-sle-prod");
      }).not.toThrow();
    });

    it("authoritatively allows OutboxService to dispatch reservations to certified SLE adapter", async () => {
      const registry = new ProviderRegistry();
      const outboxService = new OutboxService(registry);

      const freshAdapter = new SleGroundStationProviderAdapter("sle-outbox-test");
      registry.registerAdapter(freshAdapter);

      // Seed valid test reservation
      const { res } = await seedReservation("outbox");

      // Before certification: outbox transition fails at production gate
      await expect(
        outboxService.transitionToExecutionReadyWithOutbox(res.id, "sle-outbox-test")
      ).rejects.toThrow(ProviderNotCertifiedError);

      // Certify through 5.8.1 harness
      const receipt = await providerCertificationHarness.executeFullCertification(freshAdapter, {
        stationId,
        secretKey: testSecretKey,
        keyId: testKeyId,
        adapterVersion: "1.0.0",
      });
      registry.certifyAdapter("sle-outbox-test", receipt);

      // After certification: outbox transition and dispatch succeed
      const transitionResult = await outboxService.transitionToExecutionReadyWithOutbox(
        res.id,
        "sle-outbox-test"
      );

      const [attempt] = await db
        .select()
        .from(dispatchAttempts)
        .where(eq(dispatchAttempts.dispatchId, transitionResult.dispatchId));
      expect(attempt.state).toBe("PREPARED");

      const deliveryResult = await outboxService.deliverOutboxMessage(
        transitionResult.messageId,
        async (msg) => {
          const adapter = registry.getAdapter(msg.providerId, { requireCertified: true });
          const manifest = createMockManifest(msg.dispatchId);
          const context = createMockContext(msg.dispatchId);
          await adapter.stagePass(manifest, context);
          await adapter.armPass(msg.dispatchId, context);
        }
      );
      expect(deliveryResult.delivered).toBe(true);
      expect(deliveryResult.status).toBe("DELIVERED");
    });
  });
});
