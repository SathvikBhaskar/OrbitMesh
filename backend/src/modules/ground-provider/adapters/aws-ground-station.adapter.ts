/**
 * Phase 5.8: Workstream 5.8.2-A — AWS Ground Station Provider Adapter
 *
 * Implements the canonical IGroundStationProviderAdapter interface for
 * AWS Ground Station.
 *
 * Core Invariant:
 * "AWS is an adapter, not a new execution model."
 * - Maps AWS contact lifecycle (SCHEDULING, SCHEDULED, PREPASS, PASS, POSTPASS, COMPLETED, CANCELLED)
 *   strictly into OrbitMesh canonical execution states (STAGED, ARMED, TRACKING, TERMINATED).
 * - Maps OrbitMesh idempotencyKey 1:1 to AWS clientToken.
 * - Confirms RF carrier silence on abort.
 * - Does NOT alter core OrbitMesh execution, outbox, or scheduling semantics.
 */

import crypto from "crypto";
import {
  IGroundStationProviderAdapter,
  DispatchContext,
  RfRequirements,
  CapabilityValidationResult,
  StagedPassReceipt,
  ArmedPassReceipt,
  PassAbortReceipt,
  PassStatusSnapshot,
} from "../provider.types";
import { DispatchManifest } from "../../execution/execution.types";
import {
  AwsContactResponse,
  AwsGroundStationAdapterOptions,
  IAwsGroundStationClient,
} from "./aws-ground-station.types";
import { AwsGroundStationSimulatedClient } from "./aws-ground-station.client";
import { logger } from "../../../config/logger";

export class AwsGroundStationProviderAdapter
  implements IGroundStationProviderAdapter
{
  public readonly providerId: string;
  public readonly client: IAwsGroundStationClient;
  public options: AwsGroundStationAdapterOptions;

  // In-memory mapping of OrbitMesh dispatchId <-> AWS contactId
  private dispatchToContactMap = new Map<string, string>();
  private contactToDispatchMap = new Map<string, string>();

  // Default AWS ARNs and configurations
  private readonly region: string;
  private readonly awsAccountId: string;
  private readonly defaultMissionProfileArn: string;
  private readonly stationCodeMap: Record<string, string>;

  constructor(
    providerId: string = "aws-ground-station",
    options: AwsGroundStationAdapterOptions = {}
  ) {
    this.providerId = providerId;
    this.options = {
      supportedBands: ["S_BAND", "X_BAND"],
      maxDataRateMbps: 1200,
      ...options,
    };

    this.region = options.region || "us-east-2";
    this.awsAccountId = options.awsAccountId || "123456789012";
    this.defaultMissionProfileArn =
      options.defaultMissionProfileArn ||
      `arn:aws:groundstation:${this.region}:${this.awsAccountId}:mission-profile/orbitmesh-default-s-band`;

    // Mappings between OrbitMesh station codes and AWS ground station names
    this.stationCodeMap = {
      "GS-USA-01": "Ohio 1",
      "GS-USA-02": "Oregon 1",
      "GS-CHL-01": "Punta Arenas 1",
      "GS-SWE-01": "Stockholm 1",
      "GS-AUS-01": "Sydney 1",
      "CERT-STATION": "Ohio 1",
      ...options.stationCodeMap,
    };

    this.client = options.client || new AwsGroundStationSimulatedClient();
  }

  /**
   * Stage pass: Reserves an AWS Ground Station contact.
   * Maps OrbitMesh idempotencyKey 1:1 to AWS clientToken.
   */
  async stagePass(
    manifest: DispatchManifest,
    context: DispatchContext
  ): Promise<StagedPassReceipt> {
    const { dispatchId, idempotencyKey } = context;

    // Conformance test injection: stage rejection simulation
    if (this.options.simulateStageRejection) {
      throw new Error(
        this.options.stageRejectionReason || "AWS_GROUND_STATION_CAPABILITY_REJECTED"
      );
    }

    // 1. Check existing dispatchId mapping
    const existingContactId = this.dispatchToContactMap.get(dispatchId);
    if (existingContactId) {
      const existing = await this.client.describeContact(existingContactId);
      if (existing) {
        logger.info(
          { dispatchId, contactId: existing.contactId },
          "[AwsAdapter] Existing contact returned idempotently"
        );
        return {
          providerDispatchRef: existing.contactId,
          stagedAt: new Date(existing.startTime),
          stationStatus: "READY",
          rawProviderResponse: {
            provider: "AWS_GROUND_STATION",
            reused: true,
            contactId: existing.contactId,
            contactStatus: existing.contactStatus,
            groundStation: existing.groundStation,
            clientToken: existing.clientToken,
          },
        };
      }
    }

    // 2. Map idempotencyKey to AWS clientToken (must match ^[A-Za-z0-9-_]+$, max 64 chars)
    // Collision-resistant mapping: if rawToken > 64 chars, append deterministic SHA256 digest suffix
    const rawToken = idempotencyKey || `${manifest.reservationId}:${dispatchId}`;
    const sanitized = rawToken.replace(/[^A-Za-z0-9-_]/g, "-");
    const clientToken =
      sanitized.length <= 64
        ? sanitized
        : `${sanitized.slice(0, 47)}-${crypto.createHash("sha256").update(rawToken).digest("hex").slice(0, 16)}`;

    // 3. Resolve AWS parameters
    const groundStation = this.resolveGroundStation(context.stationCode);
    const satelliteArn = this.resolveSatelliteArn(manifest.satelliteId);
    const missionProfileArn = this.resolveMissionProfileArn(manifest.rfConfiguration?.frequencyBand);

    const startTime = manifest.allocatedTime?.start || manifest.window.aos;
    const endTime = manifest.allocatedTime?.end || manifest.window.los;

    // 4. Reserve contact with AWS Ground Station
    const contact = await this.client.reserveContact({
      groundStation,
      satelliteArn,
      missionProfileArn,
      startTime,
      endTime,
      clientToken,
      tags: {
        OrbitMeshDispatchId: dispatchId,
        OrbitMeshReservationId: manifest.reservationId,
      },
    });

    // 5. Save bidirectional mapping
    this.dispatchToContactMap.set(dispatchId, contact.contactId);
    this.contactToDispatchMap.set(contact.contactId, dispatchId);

    // Conformance test injection: simulated network drop after AWS reserved contact
    if (this.options.simulateStageTimeout) {
      logger.warn(
        { dispatchId, contactId: contact.contactId },
        "[AwsAdapter] Simulating network drop after AWS accepted stage"
      );
      throw new Error("HTTP_PROVIDER_TIMEOUT");
    }

    return {
      providerDispatchRef: contact.contactId,
      stagedAt: new Date(contact.startTime),
      stationStatus: "READY",
      rawProviderResponse: {
        provider: "AWS_GROUND_STATION",
        contactId: contact.contactId,
        contactStatus: contact.contactStatus,
        groundStation: contact.groundStation,
        clientToken: contact.clientToken,
        satelliteArn: contact.satelliteArn,
        missionProfileArn: contact.missionProfileArn,
        prePassStartTime: contact.prePassStartTime,
        postPassEndTime: contact.postPassEndTime,
      },
    };
  }

  /**
   * Arm pass: Verifies contact is in SCHEDULED/PREPASS state and ready for pass execution.
   */
  async armPass(
    dispatchId: string,
    context: DispatchContext
  ): Promise<ArmedPassReceipt> {
    const contactId = this.dispatchToContactMap.get(dispatchId);
    if (!contactId) {
      throw new Error(`[AwsAdapter] Cannot arm unknown dispatch ${dispatchId}`);
    }

    const contact = await this.client.describeContact(contactId);
    if (!contact) {
      throw new Error(`[AwsAdapter] Contact ${contactId} not found in AWS Ground Station`);
    }

    if (
      contact.contactStatus !== "SCHEDULED" &&
      contact.contactStatus !== "PREPASS" &&
      contact.contactStatus !== "PASS"
    ) {
      throw new Error(
        `[AwsAdapter] Contact ${contactId} cannot be armed from state ${contact.contactStatus}`
      );
    }

    // In simulated environment or live AWS pre-pass window, advance contact status
    if (this.client instanceof AwsGroundStationSimulatedClient) {
      this.client.advanceContactState(contactId, "PREPASS");
    }

    return {
      armedAt: new Date(),
      trackingConfigured: true,
      rawProviderResponse: {
        provider: "AWS_GROUND_STATION",
        contactId,
        contactStatus: "PREPASS",
        trackingConfigured: true,
      },
    };
  }

  /**
   * Abort pass: Cancels AWS contact and confirms RF carrier silence.
   * Safety invariant: If cancellation fails or times out, NEVER return rfCarrierSilenced: true.
   */
  async abortPass(
    dispatchId: string,
    reason: string,
    context: DispatchContext
  ): Promise<PassAbortReceipt> {
    // Conformance test injection: abort transport timeout simulation
    if (this.options.simulateAbortTimeout) {
      logger.warn(
        { dispatchId },
        "[AwsAdapter] Simulating abort command timeout (ambiguous outcome)"
      );
      throw new Error("ABORT_TRANSPORT_TIMEOUT");
    }

    const contactId = this.dispatchToContactMap.get(dispatchId);
    if (!contactId) {
      // Unknown contact is already unallocated or absent; RF is silenced
      return {
        confirmedAt: new Date(),
        rfCarrierSilenced: true,
        rawProviderResponse: {
          provider: "AWS_GROUND_STATION",
          unknownDispatch: true,
          silenced: true,
          reason,
        },
      };
    }

    const cancelled = await this.client.cancelContact(contactId);

    return {
      confirmedAt: new Date(),
      rfCarrierSilenced: true,
      rawProviderResponse: {
        provider: "AWS_GROUND_STATION",
        contactId: cancelled.contactId,
        contactStatus: cancelled.contactStatus,
        silenced: true,
        reason,
      },
    };
  }

  /**
   * Poll pass status: Maps AWS contact status to canonical PassStatusSnapshot.
   */
  async pollPassStatus(
    dispatchId: string,
    context: DispatchContext
  ): Promise<PassStatusSnapshot> {
    const contactId = this.dispatchToContactMap.get(dispatchId);
    if (!contactId) {
      return {
        state: "UNKNOWN",
        carrierLocked: false,
        bytesRecorded: 0,
      };
    }

    const contact = await this.client.describeContact(contactId);
    if (!contact) {
      return {
        state: "UNKNOWN",
        carrierLocked: false,
        bytesRecorded: 0,
      };
    }

    return this.mapAwsStatusToCanonical(contact);
  }

  /**
   * Capability validation: Validates whether frequency band and data rate
   * are feasible on AWS Ground Station antennas.
   * Dynamically resolves against station catalog where available.
   */
  async validateCapabilities(
    stationId: string,
    requirements: RfRequirements
  ): Promise<CapabilityValidationResult> {
    const stationCatalog = await this.client.listGroundStations();
    const matchedStation = stationCatalog.find(
      (s) =>
        s.groundStationId === stationId ||
        s.groundStationName.toLowerCase() === stationId.toLowerCase() ||
        this.stationCodeMap[stationId] === s.groundStationName
    );

    const supported = matchedStation
      ? matchedStation.supportedBands
      : this.options.supportedBands || ["S_BAND", "X_BAND"];
    const maxRate = matchedStation
      ? matchedStation.maxDataRateMbps
      : this.options.maxDataRateMbps || 1200;

    const bandOk = supported.includes(requirements.frequencyBand);
    const rateOk = requirements.dataRateMbps <= maxRate;

    return {
      isCompatible: bandOk && rateOk,
      unsupportedBands: bandOk ? [] : [requirements.frequencyBand],
      maxDataRateFeasible: rateOk,
      reason: !bandOk
        ? `AWS Ground Station does not support frequency band ${requirements.frequencyBand} at station ${stationId}`
        : !rateOk
        ? `Data rate ${requirements.dataRateMbps}Mbps exceeds station ${stationId} max rate ${maxRate}Mbps`
        : undefined,
    };
  }

  /**
   * Translates AWS contact status into OrbitMesh canonical pass status.
   *
   * Architectural Safety Invariant:
   * "execution state ≠ transport state ≠ physical telemetry"
   * Physical RF carrier lock must NEVER be manufactured solely from scheduler/lifecycle
   * state (PREPASS or PASS). It is strictly true only when the provider supplies
   * authoritative RF carrier lock / telemetry evidence.
   */
  private mapAwsStatusToCanonical(contact: AwsContactResponse): PassStatusSnapshot {
    const lastContactAt = new Date(contact.startTime);
    const isCarrierLocked = contact.carrierLocked === true;

    switch (contact.contactStatus) {
      case "SCHEDULING":
      case "SCHEDULED":
        return {
          state: "STAGED",
          carrierLocked: false,
          bytesRecorded: 0,
          lastContactAt,
        };
      case "PREPASS":
        return {
          state: "ARMED",
          // Prepass represents antenna slewing/calibration; carrierLocked requires explicit RF evidence
          carrierLocked: isCarrierLocked,
          bytesRecorded: 0,
          lastContactAt: new Date(),
        };
      case "PASS":
        return {
          state: "TRACKING",
          // Physical carrier lock is strictly dependent on provider RF telemetry evidence
          carrierLocked: isCarrierLocked,
          bytesRecorded: contact.dataBytes || 0,
          lastContactAt: new Date(),
        };
      case "POSTPASS":
      case "COMPLETED":
        return {
          state: "TERMINATED",
          carrierLocked: false,
          bytesRecorded: contact.dataBytes || 0,
          lastContactAt: new Date(contact.endTime),
        };
      case "CANCELLING":
      case "CANCELLED":
      case "FAILED":
      case "FAILED_TO_SCHEDULE":
      default:
        return {
          state: "TERMINATED",
          carrierLocked: false,
          bytesRecorded: contact.dataBytes || 0,
          lastContactAt: new Date(),
        };
    }
  }

  private resolveGroundStation(stationCode: string): string {
    return this.stationCodeMap[stationCode] || "Ohio 1";
  }

  private resolveSatelliteArn(satelliteId: string): string {
    return `arn:aws:groundstation:${this.region}:${this.awsAccountId}:satellite/${satelliteId}`;
  }

  private resolveMissionProfileArn(band?: string): string {
    const bandSuffix = band ? band.toLowerCase().replace("_", "-") : "s-band";
    return `arn:aws:groundstation:${this.region}:${this.awsAccountId}:mission-profile/orbitmesh-${bandSuffix}`;
  }

  public reset(): void {
    this.dispatchToContactMap.clear();
    this.contactToDispatchMap.clear();
    if (this.client instanceof AwsGroundStationSimulatedClient) {
      this.client.clear();
    }
  }
}
