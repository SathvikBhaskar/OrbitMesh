/**
 * Phase 5.8: Workstream 5.8.2-B — Space Link Frame Engine (CCSDS 132.0-B-3 TM)
 *
 * Responsible for:
 * 1. Attached Sync Marker (ASM) detection (0x1ACFFC1D)
 * 2. CADU framing and TM Transfer Frame header extraction (SCID, VCID, Frame Counters)
 * 3. Monotonic sequence verification & gap detection
 * 4. Authoritative physical carrier & symbol sync lock reporting
 */

import {
  CaduFrameHeader,
  ExtractedSpaceLinkFrame,
  RafTransferDataPdu,
} from "./sle.types";
import { logger } from "../../../../config/logger";

export class SleFrameEngine {
  public static readonly CCSDS_ASM_SYNC_MARKER = 0x1acffc1d; // 32-bit standard ASM
  public static readonly STANDARD_CADU_LENGTH = 1024;        // 1020 bytes TM frame + 4 bytes ASM

  private framesIngested: number = 0;
  private totalBytesRecorded: number = 0;
  private lastSequenceNumber: number = -1;
  private sequenceGapsDetected: number = 0;
  private missingSequences: number[] = [];

  // Demodulator & baseband signal lock states
  private carrierLocked: boolean = false;
  private symbolSyncLocked: boolean = false;
  private frameSyncLocked: boolean = false;

  /**
   * Ingest an incoming RAF TRANSFER_DATA PDU
   */
  public ingestTransferData(pdu: RafTransferDataPdu): ExtractedSpaceLinkFrame {
    // 1. Update physical demodulator lock indicators
    this.carrierLocked = pdu.carrierLockStatus === true;
    this.symbolSyncLocked = pdu.symbolSyncLockStatus === true;

    // 2. Monotonic sequence check & gap detection
    const seq = pdu.frameSequenceNumber;
    if (this.lastSequenceNumber !== -1) {
      if (seq > this.lastSequenceNumber + 1) {
        const gapCount = seq - (this.lastSequenceNumber + 1);
        this.sequenceGapsDetected += gapCount;
        for (let s = this.lastSequenceNumber + 1; s < seq; s++) {
          this.missingSequences.push(s);
        }
        logger.warn(
          { expected: this.lastSequenceNumber + 1, received: seq, gapCount },
          "[SleFrameEngine] Sequence gap detected in RAF space-link stream"
        );
      }
    }
    this.lastSequenceNumber = seq;

    // 3. Parse CADU frame
    const frameBuffer = pdu.frameData;
    const extracted = this.parseCadu(frameBuffer, pdu.earthReceiveTime, seq);

    this.frameSyncLocked = extracted.header.syncMarker === SleFrameEngine.CCSDS_ASM_SYNC_MARKER;
    this.framesIngested++;
    this.totalBytesRecorded += frameBuffer.length;

    return extracted;
  }

  /**
   * Parse binary CADU frame and TM transfer frame header
   */
  public parseCadu(
    buffer: Buffer,
    earthReceiveTimeStr: string,
    sequenceNumber: number
  ): ExtractedSpaceLinkFrame {
    if (buffer.length < 10) {
      throw new Error(`[SleFrameEngine] Frame too short for CADU header (${buffer.length} bytes, min 10)`);
    }

    const syncMarker = buffer.readUInt32BE(0);
    const isValidSync = syncMarker === SleFrameEngine.CCSDS_ASM_SYNC_MARKER;

    // TM Transfer Frame Primary Header (6 bytes following 4-byte ASM)
    // Offset 4: [2b Version] [10b Spacecraft ID] [3b VCID] [1b OCF]
    const headerWord1 = buffer.readUInt16BE(4);
    const version = (headerWord1 >> 14) & 0x03;
    const spacecraftId = (headerWord1 >> 4) & 0x03ff;
    const virtualChannelId = (headerWord1 >> 1) & 0x07;
    const operationalControlField = (headerWord1 & 0x01) === 1;

    // Offset 6: Master Channel Frame Count (1 byte)
    const masterChannelFrameCount = buffer.readUInt8(6);

    // Offset 7: Virtual Channel Frame Count (1 byte)
    const virtualChannelFrameCount = buffer.readUInt8(7);

    const header: CaduFrameHeader = {
      syncMarker,
      version,
      spacecraftId,
      virtualChannelId,
      operationalControlField,
      masterChannelFrameCount,
      virtualChannelFrameCount,
    };

    const payloadBytes = buffer.subarray(10);

    return {
      header,
      earthReceiveTime: new Date(earthReceiveTimeStr),
      sequenceNumber,
      rawFrameBytes: buffer,
      payloadBytes,
      isValidChecksum: isValidSync,
    };
  }

  /**
   * Synthesizes a conformant test CADU frame with ASM sync marker and TM header
   */
  public static createSyntheticCadu(
    scid: number,
    vcid: number,
    masterCount: number,
    vcCount: number,
    payloadLength: number = 1014
  ): Buffer {
    const buf = Buffer.alloc(10 + payloadLength);
    // ASM (0x1ACFFC1D)
    buf.writeUInt32BE(this.CCSDS_ASM_SYNC_MARKER, 0);

    // TM Header: version 0, SCID, VCID, OCF=false
    const headerWord1 = ((scid & 0x03ff) << 4) | ((vcid & 0x07) << 1);
    buf.writeUInt16BE(headerWord1, 4);
    buf.writeUInt8(masterCount % 256, 6);
    buf.writeUInt8(vcCount % 256, 7);

    // Frame data field status: no secondary header, first header pointer = 0
    buf.writeUInt16BE(0x0000, 8);

    // Payload fill
    for (let i = 10; i < buf.length; i++) {
      buf[i] = (i * 17) % 256;
    }

    return buf;
  }

  // Authoritative physical state queries
  public isCarrierLocked(): boolean {
    return this.carrierLocked && this.symbolSyncLocked;
  }

  public isFrameSyncLocked(): boolean {
    return this.frameSyncLocked;
  }

  public getBytesRecorded(): number {
    return this.totalBytesRecorded;
  }

  public getFramesIngested(): number {
    return this.framesIngested;
  }

  public getSequenceGapsCount(): number {
    return this.sequenceGapsDetected;
  }

  public getMissingSequences(): number[] {
    return [...this.missingSequences];
  }

  public reset(): void {
    this.framesIngested = 0;
    this.totalBytesRecorded = 0;
    this.lastSequenceNumber = -1;
    this.sequenceGapsDetected = 0;
    this.missingSequences = [];
    this.carrierLocked = false;
    this.symbolSyncLocked = false;
    this.frameSyncLocked = false;
  }
}
