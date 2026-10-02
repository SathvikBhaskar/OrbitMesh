/**
 * Phase 5.8: Workstream 5.8.2-A — AWS Ground Station Client & Simulator
 *
 * Implements:
 * 1. AwsGroundStationSimulatedClient: Full-fidelity in-memory client
 *    guaranteeing clientToken idempotency, contact state progression,
 *    and AWS Ground Station REST response shapes.
 * 2. AwsSigV4Signer: Cryptographic AWS Signature Version 4 engine for live endpoints.
 */

import crypto from "crypto";
import {
  AwsContactResponse,
  AwsContactStatus,
  AwsGroundStationInfo,
  AwsReserveContactRequest,
  IAwsGroundStationClient,
} from "./aws-ground-station.types";
import { logger } from "../../../config/logger";

/**
 * High-fidelity in-memory AWS Ground Station client
 */
export class AwsGroundStationSimulatedClient implements IAwsGroundStationClient {
  private contactsById = new Map<string, AwsContactResponse>();
  private contactsByClientToken = new Map<string, AwsContactResponse>();

  private groundStations: AwsGroundStationInfo[] = [
    {
      groundStationId: "gs-us-east-2-ohio",
      groundStationName: "Ohio 1",
      region: "us-east-2",
      supportedBands: ["S_BAND", "X_BAND"],
      maxDataRateMbps: 1200,
    },
    {
      groundStationId: "gs-us-west-2-oregon",
      groundStationName: "Oregon 1",
      region: "us-west-2",
      supportedBands: ["S_BAND", "X_BAND"],
      maxDataRateMbps: 1200,
    },
    {
      groundStationId: "gs-sa-east-1-punta-arenas",
      groundStationName: "Punta Arenas 1",
      region: "sa-east-1",
      supportedBands: ["S_BAND", "X_BAND"],
      maxDataRateMbps: 500,
    },
    {
      groundStationId: "gs-eu-north-1-stockholm",
      groundStationName: "Stockholm 1",
      region: "eu-north-1",
      supportedBands: ["S_BAND", "X_BAND"],
      maxDataRateMbps: 1200,
    },
    {
      groundStationId: "gs-ap-southeast-2-sydney",
      groundStationName: "Sydney 1",
      region: "ap-southeast-2",
      supportedBands: ["S_BAND", "X_BAND"],
      maxDataRateMbps: 1000,
    },
  ];

  /**
   * Reserves contact with AWS Ground Station.
   * Guarantees 100% idempotency on clientToken.
   */
  async reserveContact(request: AwsReserveContactRequest): Promise<AwsContactResponse> {
    const { clientToken } = request;

    // 1. Enforce AWS clientToken idempotency
    const existing = this.contactsByClientToken.get(clientToken);
    if (existing) {
      logger.info(
        { clientToken, contactId: existing.contactId },
        "[AwsGroundStationClient] Existing contact returned idempotently via clientToken"
      );
      return { ...existing };
    }

    // 2. Validate timing windows
    const startMs = new Date(request.startTime).getTime();
    const endMs = new Date(request.endTime).getTime();
    if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) {
      throw new Error(`AWS InvalidParameterException: Invalid contact time window [${request.startTime} - ${request.endTime}]`);
    }

    // 3. Compute pre-pass (-10 min) and post-pass (+5 min) margins
    const prePassStartTime = new Date(startMs - 10 * 60 * 1000).toISOString();
    const postPassEndTime = new Date(endMs + 5 * 60 * 1000).toISOString();

    const contactId = crypto.randomUUID();
    const contact: AwsContactResponse = {
      contactId,
      contactStatus: "SCHEDULED",
      groundStation: request.groundStation,
      satelliteArn: request.satelliteArn,
      missionProfileArn: request.missionProfileArn,
      startTime: request.startTime,
      endTime: request.endTime,
      prePassStartTime,
      postPassEndTime,
      clientToken,
      tags: request.tags ? { ...request.tags } : {},
      dataBytes: 0,
      creationTime: new Date().toISOString(),
    };

    this.contactsById.set(contactId, contact);
    this.contactsByClientToken.set(clientToken, contact);

    logger.info(
      { contactId, groundStation: request.groundStation, clientToken },
      "[AwsGroundStationClient] Contact reserved successfully in AWS Ground Station"
    );

    return { ...contact };
  }

  async describeContact(contactId: string): Promise<AwsContactResponse | null> {
    const contact = this.contactsById.get(contactId);
    if (!contact) {
      return null;
    }
    return { ...contact };
  }

  async cancelContact(contactId: string): Promise<AwsContactResponse> {
    const contact = this.contactsById.get(contactId);
    if (!contact) {
      throw new Error(`AWS ResourceNotFoundException: Contact ${contactId} does not exist`);
    }

    if (contact.contactStatus === "CANCELLED" || contact.contactStatus === "COMPLETED") {
      return { ...contact };
    }

    contact.contactStatus = "CANCELLED";
    logger.info({ contactId }, "[AwsGroundStationClient] Contact cancelled and RF transmission silenced");
    return { ...contact };
  }

  async listGroundStations(): Promise<AwsGroundStationInfo[]> {
    return [...this.groundStations];
  }

  /**
   * Test helper to advance contact state (e.g. into PREPASS, PASS, or COMPLETED)
   */
  public advanceContactState(
    contactId: string,
    status: AwsContactStatus,
    dataBytes: number = 0,
    carrierLocked?: boolean
  ): void {
    const contact = this.contactsById.get(contactId);
    if (contact) {
      contact.contactStatus = status;
      if (dataBytes > 0) {
        contact.dataBytes = dataBytes;
      }
      if (carrierLocked !== undefined) {
        contact.carrierLocked = carrierLocked;
      }
    }
  }

  public clear(): void {
    this.contactsById.clear();
    this.contactsByClientToken.clear();
  }
}

/**
 * AWS Signature Version 4 (SigV4) Signer
 * Implements the standard AWS SigV4 specification for authenticating REST requests.
 */
export class AwsSigV4Signer {
  public static signRequest(params: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
    service: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    timestamp?: Date;
  }): Record<string, string> {
    const {
      method,
      url,
      headers,
      body = "",
      service,
      region,
      accessKeyId,
      secretAccessKey,
      sessionToken,
      timestamp = new Date(),
    } = params;

    const amzDate = timestamp.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.substring(0, 8);

    const parsedUrl = new URL(url);
    const host = parsedUrl.host;
    const canonicalUri = parsedUrl.pathname || "/";
    const canonicalQuery = parsedUrl.searchParams.toString();

    const signedHeadersList: Record<string, string> = {
      ...headers,
      host,
      "x-amz-date": amzDate,
    };

    if (sessionToken) {
      signedHeadersList["x-amz-security-token"] = sessionToken;
    }

    // Payload hash
    const payloadHash = crypto.createHash("sha256").update(body, "utf8").digest("hex");
    signedHeadersList["x-amz-content-sha256"] = payloadHash;

    // Canonical headers
    const sortedHeaderKeys = Object.keys(signedHeadersList).sort();
    const canonicalHeaders = sortedHeaderKeys
      .map((k) => `${k.toLowerCase()}:${(signedHeadersList[k] ?? "").trim()}\n`)
      .join("");
    const signedHeaders = sortedHeaderKeys.map((k) => k.toLowerCase()).join(";");

    const canonicalRequest = [
      method.toUpperCase(),
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
    ].join("\n");

    // Derive signing key
    const kDate = crypto.createHmac("sha256", `AWS4${secretAccessKey}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac("sha256", kDate).update(region).digest();
    const kService = crypto.createHmac("sha256", kRegion).update(service).digest();
    const kSigning = crypto.createHmac("sha256", kService).update("aws4_request").digest();

    const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

    const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      ...signedHeadersList,
      Authorization: authorizationHeader,
    };
  }
}
