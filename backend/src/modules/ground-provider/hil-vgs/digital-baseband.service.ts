/**
 * Phase 5.8: Workstream 5.8.4 — Hardware-in-the-Loop (HIL) & Virtual Ground Station (VGS)
 * Digital Baseband Processing, VITA 49 Framing, and CCSDS CADU Sync Engine
 */

import crypto from "crypto";
import { logger } from "../../../config/logger";

export interface Vita49Packet {
  readonly packetType: "IF_DATA" | "CONTEXT";
  readonly streamId: number;
  readonly sequenceNumber: number;
  readonly timestampSeconds: number;
  readonly timestampPicoseconds: bigint;
  readonly sampleCount: number;
  readonly payload: Buffer; // Digitized I/Q samples or demoded symbols
}

export interface CaduFrame {
  readonly frameNumber: number;
  readonly scid: number; // Spacecraft ID
  readonly vcid: number; // Virtual Channel ID
  readonly virtualChannelFrameCount: number;
  readonly rawBuffer: Buffer;
  readonly hasValidAsm: boolean;
  readonly crcValid: boolean;
}

export interface BasebandMetrics {
  readonly framesProcessed: number;
  readonly validFrames: number;
  readonly droppedFrames: number;
  readonly bitErrorRate: number;
  readonly frameErrorRate: number;
  readonly syncState: "SEARCH" | "CHECK" | "LOCK" | "FLYWHEEL";
  readonly byteTransferCount: number;
}

export class DigitalBasebandService {
  public static readonly ASM_MARKER = Buffer.from([0x1a, 0xcf, 0xfc, 0x1d]); // 0x1ACFFC1D
  public static readonly CADU_FRAME_SIZE = 1024; // 1024 bytes per standard TM frame
  public static readonly STREAM_ID_DEFAULT = 0x4f4d4553; // "OMES" in ASCII

  private syncState: "SEARCH" | "CHECK" | "LOCK" | "FLYWHEEL" = "SEARCH";
  private consecutiveSyncHits = 0;
  private flywheelCounter = 0;
  private readonly maxFlywheelFrames = 2;

  private totalFramesProcessed = 0;
  private totalValidFrames = 0;
  private totalDroppedFrames = 0;
  private totalBytesTransferred = 0;

  // Stream state
  private vitaSequence = 0;

  /**
   * Package digitized IF / demoded data into a VITA 49 Radio Transport Packet
   */
  public createVita49Packet(payload: Buffer, timestamp = new Date()): Vita49Packet {
    this.vitaSequence = (this.vitaSequence + 1) % 4096;
    const epochSec = Math.floor(timestamp.getTime() / 1000);
    const picoSec = BigInt(timestamp.getTime() % 1000) * 1_000_000_000n;

    return {
      packetType: "IF_DATA",
      streamId: DigitalBasebandService.STREAM_ID_DEFAULT,
      sequenceNumber: this.vitaSequence,
      timestampSeconds: epochSec,
      timestampPicoseconds: picoSec,
      sampleCount: Math.floor(payload.length / 4), // 16-bit I + 16-bit Q = 4 bytes/sample
      payload,
    };
  }

  /**
   * Synthesize a CCSDS Channel Access Data Unit (CADU) with valid ASM and Frame Header
   */
  public generateCaduFrame(
    frameIndex: number,
    scid: number,
    vcid: number,
    userDataSize = 1016
  ): Buffer {
    const frame = Buffer.alloc(DigitalBasebandService.CADU_FRAME_SIZE);

    // 1. Attached Sync Marker (ASM) 4 bytes: 0x1ACFFC1D
    DigitalBasebandService.ASM_MARKER.copy(frame, 0);

    // 2. TM Transfer Frame Primary Header (6 bytes):
    // Version (2 bits = 00), SCID (10 bits), VCID (3 bits), OCF flag (1 bit = 0)
    const word0 = ((0 & 0x03) << 14) | ((scid & 0x03ff) << 4) | ((vcid & 0x07) << 1);
    frame.writeUInt16BE(word0, 4);

    // Master / Virtual Channel Frame Count (3 bytes)
    const vcCount = frameIndex & 0xffffff;
    frame.writeUInt8((vcCount >> 16) & 0xff, 6);
    frame.writeUInt16BE(vcCount & 0xffff, 7);

    // Data Field Status (1 byte)
    frame.writeUInt8(0x00, 9);

    // 3. User Telemetry Payload Data
    const payloadBuffer = crypto.randomBytes(userDataSize);
    payloadBuffer.copy(frame, 10, 0, Math.min(userDataSize, DigitalBasebandService.CADU_FRAME_SIZE - 12));

    // 4. Frame Error Control Field (CRC-16 CCITT) in last 2 bytes
    const crc = this.computeCrc16(frame.subarray(4, DigitalBasebandService.CADU_FRAME_SIZE - 2));
    frame.writeUInt16BE(crc, DigitalBasebandService.CADU_FRAME_SIZE - 2);

    return frame;
  }

  /**
   * Compute CRC-16 CCITT (polynomial 0x1021)
   */
  public computeCrc16(buffer: Buffer): number {
    let crc = 0xffff;
    for (let i = 0; i < buffer.length; i++) {
      crc ^= (buffer[i]! << 8);
      for (let j = 0; j < 8; j++) {
        if ((crc & 0x8000) !== 0) {
          crc = ((crc << 1) ^ 0x1021) & 0xffff;
        } else {
          crc = (crc << 1) & 0xffff;
        }
      }
    }
    return crc;
  }

  /**
   * Process incoming baseband stream buffer and extract CADU frames with SNR noise modeling
   */
  public processBasebandStream(
    streamBuffer: Buffer,
    carrierLocked: boolean,
    snrDb: number
  ): { frames: CaduFrame[]; metrics: BasebandMetrics } {
    const extractedFrames: CaduFrame[] = [];

    // If carrier is not locked (e.g. transmitter silenced or signal faded), stream is pure thermal noise
    if (!carrierLocked || streamBuffer.length < DigitalBasebandService.CADU_FRAME_SIZE) {
      this.syncState = "SEARCH";
      this.consecutiveSyncHits = 0;
      this.flywheelCounter = 0;

      return {
        frames: [],
        metrics: this.getMetrics(snrDb),
      };
    }

    // Theoretical bit error rate from SNR (assuming BPSK/QPSK AWGN channel)
    // SNR_linear = 10^(snrDb / 10)
    // BER ~ 0.5 * erfc(sqrt(SNR_linear))
    const snrLinear = Math.pow(10, snrDb / 10);
    const ber = snrDb <= 0 ? 0.5 : Math.max(1e-9, 0.5 * Math.exp(-snrLinear));
    const frameLossProb = 1 - Math.pow(1 - ber, DigitalBasebandService.CADU_FRAME_SIZE * 8);

    let offset = 0;
    while (offset + DigitalBasebandService.CADU_FRAME_SIZE <= streamBuffer.length) {
      this.totalFramesProcessed++;
      const frameSlice = streamBuffer.subarray(offset, offset + DigitalBasebandService.CADU_FRAME_SIZE);

      // 1. Sync Marker Check
      const asmMatch = frameSlice.subarray(0, 4).equals(DigitalBasebandService.ASM_MARKER);

      // Frame Sync State Machine
      if (asmMatch) {
        this.consecutiveSyncHits++;
        if (this.consecutiveSyncHits >= 3) {
          this.syncState = "LOCK";
        } else {
          this.syncState = "CHECK";
        }
        this.flywheelCounter = 0;
      } else {
        if (this.syncState === "LOCK") {
          this.flywheelCounter++;
          if (this.flywheelCounter <= this.maxFlywheelFrames) {
            this.syncState = "FLYWHEEL";
          } else {
            this.syncState = "SEARCH";
            this.consecutiveSyncHits = 0;
          }
        } else {
          this.syncState = "SEARCH";
          this.consecutiveSyncHits = 0;
        }
      }

      // 2. Channel noise simulation: check if simulated bit errors corrupt this frame
      const isCorruptedByNoise = Math.random() < frameLossProb;
      const crcExpected = this.computeCrc16(frameSlice.subarray(4, DigitalBasebandService.CADU_FRAME_SIZE - 2));
      const crcStored = frameSlice.readUInt16BE(DigitalBasebandService.CADU_FRAME_SIZE - 2);
      const crcValid = !isCorruptedByNoise && crcStored === crcExpected;

      // Extract Header fields
      const word0 = frameSlice.readUInt16BE(4);
      const scid = (word0 >> 4) & 0x03ff;
      const vcid = (word0 >> 1) & 0x07;
      const vcCount = ((frameSlice.readUInt8(6) << 16) | frameSlice.readUInt16BE(7)) & 0xffffff;

      const isValid = (this.syncState === "LOCK" || this.syncState === "FLYWHEEL" || (this.syncState === "CHECK" && crcValid)) && crcValid;

      if (isValid) {
        this.totalValidFrames++;
        this.totalBytesTransferred += DigitalBasebandService.CADU_FRAME_SIZE;
        extractedFrames.push({
          frameNumber: this.totalFramesProcessed,
          scid,
          vcid,
          virtualChannelFrameCount: vcCount,
          rawBuffer: Buffer.from(frameSlice),
          hasValidAsm: asmMatch,
          crcValid: true,
        });
      } else {
        this.totalDroppedFrames++;
      }

      offset += DigitalBasebandService.CADU_FRAME_SIZE;
    }

    return {
      frames: extractedFrames,
      metrics: this.getMetrics(snrDb),
    };
  }

  /**
   * Get current digital baseband metrics
   */
  public getMetrics(snrDb: number): BasebandMetrics {
    const snrLinear = Math.pow(10, snrDb / 10);
    const ber = snrDb <= 0 ? 0.5 : Math.max(1e-9, 0.5 * Math.exp(-snrLinear));
    const fer =
      this.totalFramesProcessed > 0
        ? this.totalDroppedFrames / this.totalFramesProcessed
        : 0;

    return {
      framesProcessed: this.totalFramesProcessed,
      validFrames: this.totalValidFrames,
      droppedFrames: this.totalDroppedFrames,
      bitErrorRate: Number(ber.toExponential(2)),
      frameErrorRate: Number(fer.toFixed(4)),
      syncState: this.syncState,
      byteTransferCount: this.totalBytesTransferred,
    };
  }

  /**
   * Reset baseband engine state
   */
  public reset(): void {
    this.syncState = "SEARCH";
    this.consecutiveSyncHits = 0;
    this.flywheelCounter = 0;
    this.totalFramesProcessed = 0;
    this.totalValidFrames = 0;
    this.totalDroppedFrames = 0;
    this.totalBytesTransferred = 0;
    this.vitaSequence = 0;
  }
}

export const digitalBasebandService = new DigitalBasebandService();
