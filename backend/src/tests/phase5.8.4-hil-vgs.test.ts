/**
 * Phase 5.8: Workstream 5.8.4 — Hardware-in-the-Loop (HIL) & Virtual Ground Station (VGS)
 * 
 * Verifies:
 * 1. Digital Baseband Simulation (VITA 49, CCSDS CADU, Frame Sync Engine, BER/FER noise modeling)
 * 2. SDR Physical Channel Emulation (Doppler S-curve, Slant Range, FSPL, Atmospheric loss, Carrier Lock)
 * 3. Physical Carrier-Silencing Interlock under Channel Backlog / Saturation
 * 4. 5.8.1 Certification Conformance for Virtual Ground Station (16/16 assertions)
 * 5. Full End-to-End Pipeline: Mission -> Scheduler -> Control Plane -> Outbox -> VGS Adapter -> Telemetry -> Safety
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import crypto from "crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import {
  satellites,
  groundStations,
  contactWindows,
  missionTasks,
  reservations,
  satelliteOrbitalData,
  groundStationCredentials,
  outboundDispatchMessages,
  dispatchAttempts,
} from "../db/schema";
import {
  ChannelEmulator,
  DigitalBasebandService,
  VirtualGroundStation,
  VgsGroundStationProviderAdapter,
} from "../modules/ground-provider/hil-vgs";
import { providerCertificationHarness } from "../modules/ground-provider/certification/certification-harness.service";
import { providerRegistry } from "../modules/ground-provider/provider.registry";
import { groundSecurityService } from "../modules/ground-provider/crypto.service";
import { safetyInterlockService } from "../modules/ground-provider/safety-interlock.service";
import { OutboxService } from "../modules/outbox/outbox.service";
import { DispatchManifest } from "../modules/execution/execution.types";
import { DispatchContext } from "../modules/ground-provider/provider.types";

describe("Phase 5.8.4: Hardware-in-the-Loop (HIL) & Virtual Ground Station (VGS)", () => {
  let channel: ChannelEmulator;
  let baseband: DigitalBasebandService;
  let vgs: VirtualGroundStation;
  let vgsAdapter: VgsGroundStationProviderAdapter;
  let outboxService: OutboxService;

  // DB Fixtures
  let satId: string;
  let odId: string;
  let stationId: string;
  let missionTaskId: string;
  let contactWindowId: string;
  let windowAos: Date;
  let windowLos: Date;
  let testKeyId: string;
  const testSecretKey = "vgs-test-secret-key-32bytes-len!";

  beforeAll(async () => {
    windowAos = new Date(Date.now() + 3600000);
    windowLos = new Date(Date.now() + 4200000);

    // 1. Seed Satellite & Orbital Data
    const [sat] = await db
      .insert(satellites)
      .values({
        noradId: 58400 + Math.floor(Math.random() * 900),
        name: "HIL-VGS-SAT",
        status: "ACTIVE",
      })
      .returning();
    satId = sat!.id;

    const [od] = await db
      .insert(satelliteOrbitalData)
      .values({
        satelliteId: satId,
        source: "CELESTRAK",
        tleLine1: "1 58400U 26001A   26270.00000000  .00001000  00000-0  10000-3 0  9991",
        tleLine2: "2 58400  97.5000 120.0000 0010000  45.0000 315.0000 15.10000000000018",
        tleEpoch: new Date(),
        receivedAt: new Date(),
      })
      .returning();
    odId = od!.id;

    // 2. Seed Ground Station & Credential
    const [station] = await db
      .insert(groundStations)
      .values({
        code: `VGS-GS-${Math.floor(Math.random() * 9000 + 1000)}`,
        name: "Virtual-Ground-Station-01",
        latitude: 39.96,
        longitude: -83.0,
        altitudeM: 200,
        minimumElevationDeg: 5,
        status: "AVAILABLE",
        supportedFrequencyBands: ["S_BAND", "X_BAND"],
      })
      .returning();
    stationId = station!.id;

    testKeyId = `vgs-key-${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(groundStationCredentials).values({
      groundStationId: stationId,
      keyId: testKeyId,
      secretKey: testSecretKey,
      status: "ACTIVE",
      expiresAt: new Date(Date.now() + 86400000 * 30),
    });

    // 3. Seed Mission Task
    const [task] = await db
      .insert(missionTasks)
      .values({
        satelliteId: satId,
        name: "HIL-VGS-Task",
        priority: 1,
        durationSeconds: 600,
        deadline: new Date(Date.now() + 86400000),
        status: "SCHEDULED",
        requiredFrequencyBand: "S_BAND",
        minDataRateMbps: 50,
      })
      .returning();
    missionTaskId = task!.id;

    // 4. Seed Contact Window
    const [cw] = await db
      .insert(contactWindows)
      .values({
        satelliteId: satId,
        groundStationId: stationId,
        orbitalDataId: odId,
        aos: windowAos,
        los: windowLos,
        durationSeconds: 600,
        maxElevationDeg: 65,
      })
      .returning();
    contactWindowId = cw!.id;
  });

  afterAll(async () => {
    // Teardown DB fixtures
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
    channel = new ChannelEmulator();
    baseband = new DigitalBasebandService();
    vgs = new VirtualGroundStation("VGS-SDR-PRIMARY", {}, baseband);
    vgs.configureCredentials(testKeyId, testSecretKey);
    vgsAdapter = new VgsGroundStationProviderAdapter("vgs-sdr-provider", { vgsInstance: vgs });
    outboxService = new OutboxService(providerRegistry);
    groundSecurityService.clearNonceCache();
  });

  // =========================================================================
  // 1. Digital Baseband Simulation
  // =========================================================================
  describe("1. Digital Baseband Simulation & VITA 49 / CCSDS CADU Sync", () => {
    it("packages baseband samples into valid VITA 49 Radio Transport packets", () => {
      const samplePayload = crypto.randomBytes(400); // 100 I/Q complex samples
      const packet = baseband.createVita49Packet(samplePayload);

      expect(packet.packetType).toBe("IF_DATA");
      expect(packet.streamId).toBe(DigitalBasebandService.STREAM_ID_DEFAULT);
      expect(packet.sampleCount).toBe(100);
      expect(packet.payload.length).toBe(400);
      expect(packet.timestampSeconds).toBeGreaterThan(0);
      expect(packet.timestampPicoseconds).toBeDefined();
    });

    it("synthesizes CCSDS CADU frames with valid Attached Sync Marker (0x1ACFFC1D) and CRC-16", () => {
      const cadu = baseband.generateCaduFrame(42, 101, 1);

      expect(cadu.length).toBe(DigitalBasebandService.CADU_FRAME_SIZE);
      expect(cadu.subarray(0, 4)).toEqual(DigitalBasebandService.ASM_MARKER);

      // Verify CRC-16 integrity over CADU transfer frame
      const dataField = cadu.subarray(4, DigitalBasebandService.CADU_FRAME_SIZE - 2);
      const computedCrc = baseband.computeCrc16(dataField);
      const storedCrc = cadu.readUInt16BE(DigitalBasebandService.CADU_FRAME_SIZE - 2);

      expect(storedCrc).toBe(computedCrc);
    });

    it("acquires frame synchronization (SEARCH -> CHECK -> LOCK) and decodes CADU frames", () => {
      // Stream 5 consecutive valid CADU frames
      const chunks: Buffer[] = [];
      for (let i = 0; i < 5; i++) {
        chunks.push(baseband.generateCaduFrame(i, 101, 1));
      }
      const stream = Buffer.concat(chunks);

      const { frames, metrics } = baseband.processBasebandStream(stream, true, 18.5);

      expect(frames.length).toBe(5);
      expect(metrics.validFrames).toBe(5);
      expect(metrics.droppedFrames).toBe(0);
      expect(metrics.syncState).toBe("LOCK");
      expect(metrics.byteTransferCount).toBe(5 * DigitalBasebandService.CADU_FRAME_SIZE);
    });

    it("simulates frame error rate (FER) and flywheel behavior when SNR drops", () => {
      // Simulate low SNR channel (e.g. 2 dB - well below threshold)
      const chunks: Buffer[] = [];
      for (let i = 0; i < 20; i++) {
        chunks.push(baseband.generateCaduFrame(i, 101, 1));
      }
      const stream = Buffer.concat(chunks);

      const { metrics } = baseband.processBasebandStream(stream, true, 2.0);

      // In low SNR AWGN channel, frame loss probability increases significantly
      expect(metrics.frameErrorRate).toBeGreaterThan(0);
      expect(metrics.droppedFrames).toBeGreaterThan(0);
    });

    it("immediately halts frame decoding and resets to SEARCH when carrier is unlocked", () => {
      const validCadu = baseband.generateCaduFrame(1, 101, 1);

      // When carrierLocked = false (carrier silenced or signal loss), stream is rejected as noise
      const { frames, metrics } = baseband.processBasebandStream(validCadu, false, 0.0);

      expect(frames.length).toBe(0);
      expect(metrics.syncState).toBe("SEARCH");
    });
  });

  // =========================================================================
  // 2. SDR Physical Channel Emulation
  // =========================================================================
  describe("2. SDR Physical Channel Emulation & Space-to-Ground Physics", () => {
    it("computes Doppler frequency S-curve: positive at AOS, zero at Zenith, negative at LOS", () => {
      // AOS (-1.0): satellite approaching -> positive Doppler shift
      const aosSnapshot = channel.evaluateChannelAtProgress(-1.0);
      expect(aosSnapshot.radialVelocityKmS).toBeLessThan(0);
      expect(aosSnapshot.dopplerShiftHz).toBeGreaterThan(40000); // > +40 kHz at S-band

      // Zenith / CPA (0.0): radial velocity zero -> Doppler zero-crossing
      const zenithSnapshot = channel.evaluateChannelAtProgress(0.0);
      expect(zenithSnapshot.radialVelocityKmS).toBeCloseTo(0, 1);
      expect(zenithSnapshot.dopplerShiftHz).toBeCloseTo(0, -1);

      // LOS (+1.0): satellite receding -> negative Doppler shift
      const losSnapshot = channel.evaluateChannelAtProgress(1.0);
      expect(losSnapshot.radialVelocityKmS).toBeGreaterThan(0);
      expect(losSnapshot.dopplerShiftHz).toBeLessThan(-40000); // < -40 kHz at S-band
    });

    it("models Free Space Path Loss (FSPL) and slant range dynamic variation", () => {
      const aos = channel.evaluateChannelAtProgress(-1.0);
      const zenith = channel.evaluateChannelAtProgress(0.0);

      // Slant range is largest at AOS (~1800 km) and minimum at Zenith (~550 km)
      expect(aos.slantRangeKm).toBeGreaterThan(1500);
      expect(zenith.slantRangeKm).toBeLessThan(650);

      // Path loss difference between horizon and zenith is ~10 dB (1/R^2)
      expect(aos.fsplDb).toBeGreaterThan(zenith.fsplDb);
      const lossDelta = aos.fsplDb - zenith.fsplDb;
      expect(lossDelta).toBeGreaterThanOrEqual(8.0);
      expect(lossDelta).toBeLessThanOrEqual(13.0);
    });

    it("verifies physical carrier lock invariant based on SNR, elevation and PLL tracking", () => {
      // 1. Normal in-view pass at Zenith -> carrierLocked: true
      const normalPass = channel.evaluateChannelAtProgress(0.0);
      expect(normalPass.carrierLocked).toBe(true);
      expect(normalPass.linkStatus).toBe("CARRIER_LOCKED");
      expect(normalPass.snrDb).toBeGreaterThan(12.0);

      // 2. Below horizon -> carrierLocked: false
      const horizonGeo = channel.computeAnalyticalGeometry(-1.1); // below 5 deg
      expect(horizonGeo.elevationDeg).toBeLessThan(5.0);

      // 3. Injected massive rain fade (35 dB) -> SNR drops below 6 dB -> carrierLocked: false
      channel.setInjectedAtmosphericFade(35.0);
      const fadedPass = channel.evaluateChannelAtProgress(0.0);
      expect(fadedPass.carrierLocked).toBe(false);
      expect(fadedPass.linkStatus).toBe("SIGNAL_FADED");
      channel.setInjectedAtmosphericFade(0); // clear fade

      // 4. Injected frequency spike exceeding PLL tracking loop bandwidth -> carrierLocked: false
      channel.setInjectedFrequencyOffset(5000.0); // 5 kHz offset > 1000 Hz PLL bandwidth
      const pllLossPass = channel.evaluateChannelAtProgress(0.0);
      expect(pllLossPass.carrierLocked).toBe(false);
      channel.setInjectedFrequencyOffset(0); // clear offset
    });
  });

  // =========================================================================
  // 3. Physical Carrier-Silencing Interlock Validation
  // =========================================================================
  describe("3. Physical Carrier-Silencing Interlock under Channel Saturation", () => {
    it("actuates physical RF switch instantly (<50ms), clamping RF power to noise floor (-110 dBm)", () => {
      // 1. Stage and arm pass in VGS
      vgs.stagePass({
        dispatchId: "disp-silence-01",
        satelliteId: satId,
        stationCode: "VGS-SDR-01",
        aosTime: windowAos,
        losTime: windowLos,
        scid: 101,
        vcid: 1,
      });
      vgs.armPass("disp-silence-01");

      // Verify active transmission in progress
      vgs.stepSimulation(0.0);
      const activeSnapshot = vgs.getSnapshot(0.0);
      expect(activeSnapshot.carrierLocked).toBe(true);
      expect(activeSnapshot.rfPowerDbm).toBeGreaterThan(-100);

      // 2. Command Emergency Carrier Silencing Interlock
      const startTime = Date.now();
      const silenceResult = vgs.emergencySilenceCarrier("REGULATORY_DECONFLICTION");
      const elapsedMs = Date.now() - startTime;

      expect(elapsedMs).toBeLessThan(50); // Actuation time bound
      expect(silenceResult.silenced).toBe(true);
      expect(silenceResult.rfPowerDbm).toBe(-110.0);

      // 3. Invariant: RF power clamped, carrier lock dropped to false, SNR is 0
      const postSnapshot = vgs.getSnapshot(0.0);
      expect(postSnapshot.carrierLocked).toBe(false);
      expect(postSnapshot.carrierSilenced).toBe(true);
      expect(postSnapshot.rfPowerDbm).toBe(-110.0);
      expect(postSnapshot.snrDb).toBe(0);
      expect(postSnapshot.state).toBe("TERMINATED");
    });

    it("guarantees immediate carrier silencing even during active high-rate baseband transfer", () => {
      vgs.stagePass({
        dispatchId: "disp-backlog-01",
        satelliteId: satId,
        stationCode: "VGS-SDR-01",
        aosTime: windowAos,
        losTime: windowLos,
        scid: 101,
        vcid: 1,
      });
      vgs.armPass("disp-backlog-01");

      // Run multiple high-rate baseband streaming steps
      for (let i = 0; i < 5; i++) {
        vgs.stepSimulation(0.0);
      }
      const preBytes = vgs.getSnapshot(0.0).bytesRecorded;
      expect(preBytes).toBeGreaterThan(0);

      // Command emergency silence mid-stream
      vgs.emergencySilenceCarrier("ANOMALY_ABORT");

      // Run simulation step after silencing: zero new bytes transferred!
      vgs.stepSimulation(0.0);
      const postBytes = vgs.getSnapshot(0.0).bytesRecorded;
      expect(postBytes).toBe(preBytes); // Transmission completely frozen
    });

    it("generates cryptographically signed telemetry proving physical RF carrier is silenced", async () => {
      vgs.stagePass({
        dispatchId: "disp-telem-01",
        satelliteId: satId,
        stationCode: "VGS-SDR-01",
        aosTime: windowAos,
        losTime: windowLos,
        scid: 101,
        vcid: 1,
        keyId: testKeyId,
        secretKey: testSecretKey,
      });

      // Silence carrier
      vgs.emergencySilenceCarrier("LINK_SILENCE_PROOF");

      // Generate signed telemetry
      const signedTelem = vgs.generateSignedTelemetry(0.0);

      expect(signedTelem.payload.carrierLocked).toBe(false);
      expect(signedTelem.payload.rfPowerDbm).toBe(-110.0);

      // Verify signature using OrbitMesh groundSecurityService
      const verifyResult = await groundSecurityService.verifyTelemetrySignature(
        signedTelem.headers,
        signedTelem.dispatchId,
        signedTelem.sequenceNumber,
        signedTelem.payload
      );

      expect(verifyResult.isValid).toBe(true);
      expect(verifyResult.stationId).toBe(stationId);
    });
  });

  // =========================================================================
  // 4. Conformance Certification for VGS Provider Adapter (5.8.1 Harness)
  // =========================================================================
  describe("4. 5.8.1 Conformance Certification for Virtual Ground Station", () => {
    it("passes all 16/16 assertions of the frozen 5.8.1 Provider Certification Harness", async () => {
      const receipt = await providerCertificationHarness.executeFullCertification(vgsAdapter, {
        environment: "PRODUCTION",
      });

      expect(receipt.isCertified).toBe(true);
      expect(receipt.summary.totalAssertions).toBe(16);
      expect(receipt.summary.passedAssertions).toBe(16);
      expect(receipt.summary.semantic).toBe(true);
      expect(receipt.summary.distributed).toBe(true);
      expect(receipt.summary.security).toBe(true);
      expect(receipt.summary.safety).toBe(true);

      // Assert cryptographic receipt authenticity
      expect(receipt.signature).toBeDefined();
      expect(receipt.adapterVersion).toBe("1.0.0");
      expect(receipt.contractVersion).toBe("5.8.0");
      expect(receipt.certificationSuiteVersion).toBe("5.8.1");

      // Register certified adapter in ProviderRegistry
      providerRegistry.registerAdapter(vgsAdapter, { certificationReceipt: receipt });
      expect(providerRegistry.isCertified(vgsAdapter.providerId)).toBe(true);
    });
  });

  // =========================================================================
  // 5. Complete End-to-End Execution Pipeline
  // =========================================================================
  describe("5. Complete End-to-End Pipeline Validation", () => {
    let reservationId: string;
    let dispatchId: string;

    beforeEach(async () => {
      dispatchId = `disp-e2e-${Date.now()}`;
      // Ensure VGS adapter is certified and registered
      const receipt = await providerCertificationHarness.executeFullCertification(vgsAdapter, {
        environment: "PRODUCTION",
      });
      providerRegistry.registerAdapter(vgsAdapter, { certificationReceipt: receipt });

      // Clean lingering outbox messages, dispatch attempts, and reservations
      await db.delete(outboundDispatchMessages);
      await db.delete(dispatchAttempts);
      await db.delete(reservations).where(eq(reservations.satelliteId, satId));

      const [res] = await db
        .insert(reservations)
        .values({
          satelliteId: satId,
          groundStationId: stationId,
          missionTaskId: missionTaskId,
          contactWindowId: contactWindowId,
          windowAos,
          windowLos,
          allocatedStart: windowAos,
          allocatedEnd: windowLos,
          taskDurationSeconds: 600,
          status: "CONFIRMED",
          executionState: "SCHEDULED",
          executionInterlock: "NONE",
        })
        .returning();
      reservationId = res!.id;
    });

    it("executes complete lifecycle: Task -> Outbox -> VGS Stage -> VGS Arm -> HIL Pass -> Completion", async () => {
      const manifest: DispatchManifest = {
        dispatchId,
        reservationId,
        satelliteId: satId,
        groundStationId: stationId,
        window: {
          aos: windowAos.toISOString(),
          los: windowLos.toISOString(),
        },
        allocatedTime: {
          start: windowAos.toISOString(),
          end: windowLos.toISOString(),
        },
        satellite: {
          noradId: 58400,
          name: "HIL-VGS-SAT",
        },
        station: {
          stationCode: "VGS-SDR-PRIMARY",
          name: "Virtual-Ground-Station-01",
        },
        rfRequirements: {
          frequencyBand: "S_BAND",
          dataRateMbps: 50,
        },
      };

      // 1. Transactional Outbox: Prepare and queue STAGE_DISPATCH
      const transitionResult = await outboxService.transitionToExecutionReadyWithOutbox(
        reservationId,
        vgsAdapter.providerId,
        {
          customDispatchId: dispatchId,
          payload: manifest as any,
        }
      );
      expect(transitionResult.outboxMessage.status).toBe("PENDING");

      // 2. Deliver Outbox Message to VGS Adapter
      const deliveryResult = await outboxService.deliverOutboxMessage(
        transitionResult.messageId,
        async (msg) => {
          const adapter = providerRegistry.getAdapter(msg.providerId, { requireCertified: true });
          const context: DispatchContext = {
            dispatchId: msg.dispatchId,
            attemptNumber: 1,
            idempotencyKey: `idemp-${msg.dispatchId}`,
            correlationId: `corr-${msg.dispatchId}`,
            providerId: msg.providerId,
            stationCode: "VGS-SDR-PRIMARY",
          };
          await adapter.stagePass(manifest, context);
        }
      );
      expect(deliveryResult.delivered).toBe(true);

      // Verify VGS staged pass
      const snapshotAfterStage = await vgsAdapter.pollPassStatus(dispatchId, {
        dispatchId,
        attemptNumber: 1,
        idempotencyKey: `idemp-${dispatchId}`,
        correlationId: `corr-${dispatchId}`,
        providerId: vgsAdapter.providerId,
        stationCode: "VGS-SDR-PRIMARY",
      });
      expect(snapshotAfterStage.state).toBe("STAGED");

      // 3. Arm VGS SDR Receiver
      const armReceipt = await vgsAdapter.armPass(dispatchId, {
        dispatchId,
        attemptNumber: 1,
        idempotencyKey: `idemp-arm-${dispatchId}`,
        correlationId: `corr-arm-${dispatchId}`,
        providerId: vgsAdapter.providerId,
        stationCode: "VGS-SDR-PRIMARY",
      });
      expect(armReceipt.trackingConfigured).toBe(true);

      // 4. Execute HIL Contact Pass: AOS (-1.0) -> Zenith (0.0) -> LOS (+1.0)
      // Step A: AOS
      const aosStep = vgs.stepSimulation(-1.0);
      expect(aosStep.metrics.elevationDeg).toBeGreaterThanOrEqual(5.0);
      expect(aosStep.metrics.dopplerShiftHz).toBeGreaterThan(0);

      // Step B: Zenith (Peak Elevation)
      const zenithStep = vgs.stepSimulation(0.0);
      expect(zenithStep.metrics.elevationDeg).toBeGreaterThan(50.0);
      expect(zenithStep.metrics.carrierLocked).toBe(true);
      expect(zenithStep.frames.length).toBeGreaterThan(0);

      // Step C: LOS
      const losStep = vgs.stepSimulation(1.0);
      expect(losStep.metrics.dopplerShiftHz).toBeLessThan(0);

      // 5. Ingestion of Signed Physical Telemetry
      const signedTelem = vgs.generateSignedTelemetry(0.0);
      const verifyResult = await groundSecurityService.verifyTelemetrySignature(
        signedTelem.headers,
        signedTelem.dispatchId,
        signedTelem.sequenceNumber,
        signedTelem.payload
      );
      expect(verifyResult.isValid).toBe(true);
      expect(signedTelem.payload.bytesRecorded).toBeGreaterThan(0);
    });

    it("executes end-to-end Emergency Abort with physical carrier silencing and control-plane version advancement", async () => {
      const manifest: DispatchManifest = {
        dispatchId,
        reservationId,
        satelliteId: satId,
        groundStationId: stationId,
        window: {
          aos: windowAos.toISOString(),
          los: windowLos.toISOString(),
        },
        allocatedTime: {
          start: windowAos.toISOString(),
          end: windowLos.toISOString(),
        },
        satellite: { noradId: 58400, name: "HIL-VGS-SAT" },
        station: { stationCode: "VGS-SDR-PRIMARY", name: "VGS" },
        rfRequirements: { frequencyBand: "S_BAND", dataRateMbps: 50 },
      };

      // 1. Stage and Arm Pass
      const transitionResult = await outboxService.transitionToExecutionReadyWithOutbox(
        reservationId,
        vgsAdapter.providerId,
        {
          customDispatchId: dispatchId,
          payload: manifest as any,
        }
      );
      await outboxService.deliverOutboxMessage(
        transitionResult.messageId,
        async (msg) => {
          const adapter = providerRegistry.getAdapter(msg.providerId, { requireCertified: true });
          const context: DispatchContext = {
            dispatchId: msg.dispatchId,
            attemptNumber: 1,
            idempotencyKey: `idemp-${msg.dispatchId}`,
            correlationId: `corr-${msg.dispatchId}`,
            providerId: msg.providerId,
            stationCode: "VGS-SDR-PRIMARY",
          };
          await adapter.stagePass(manifest, context);
        }
      );
      await vgsAdapter.armPass(dispatchId, {
        dispatchId,
        attemptNumber: 1,
        idempotencyKey: `idemp-arm-${dispatchId}`,
        correlationId: `corr-${dispatchId}`,
        providerId: vgsAdapter.providerId,
        stationCode: "VGS-SDR-PRIMARY",
      });

      // Start active transmission
      vgs.stepSimulation(0.0);
      expect(vgs.getSnapshot(0.0).carrierLocked).toBe(true);

      // 2. Command Safety Interlock Emergency Abort
      const abortResult = await safetyInterlockService.commandPassAbort(
        reservationId,
        "SPACE_DEBRIS_AVOIDANCE",
        {
          providerId: vgsAdapter.providerId,
          stationCode: "VGS-SDR-PRIMARY",
        }
      );

      // 3. Invariants:
      // a) status is ABORT_CONFIRMED
      // b) physicalSilenced is true
      // c) Control plane schedule version advanced
      expect(abortResult.status).toBe("ABORT_CONFIRMED");
      expect(abortResult.physicalSilenced).toBe(true);
      expect(abortResult.versionAdvanced).toBe(true);

      // d) VGS physical RF switch clamped to noise floor
      const vgsState = vgs.getSnapshot(0.0);
      expect(vgsState.carrierLocked).toBe(false);
      expect(vgsState.carrierSilenced).toBe(true);
      expect(vgsState.rfPowerDbm).toBe(-110.0);

      // e) Reservation state transitioned to FAILED
      const [res] = await db
        .select()
        .from(reservations)
        .where(eq(reservations.id, reservationId));
      expect(res!.executionInterlock).toBe("ABORT_CONFIRMED");
      expect(res!.executionState).toBe("FAILED");
      expect(res!.failureReason).toBe("EXECUTION_ABORTED");
    });
  });
});
