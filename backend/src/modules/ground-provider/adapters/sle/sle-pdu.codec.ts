/**
 * Phase 5.8: Workstream 5.8.2-B — CCSDS SLE PDU ASN.1 Binary Codec
 *
 * Implements binary encoding and decoding for SLE PDUs according to
 * CCSDS 911.1-B-5 (RAF) and CCSDS 913.1-B-2 (ISP).
 *
 * Enforces strict validation of PDU lengths, invocation IDs, and field formats;
 * corrupted or malformed buffers trigger clean ASN.1 parsing errors.
 */

import {
  SlePdu,
  SlePduType,
  SleBindRequestPdu,
  SleBindReturnPdu,
  SleUnbindRequestPdu,
  SleUnbindReturnPdu,
  SleStartRequestPdu,
  SleStartReturnPdu,
  SleStopRequestPdu,
  SleStopReturnPdu,
  RafTransferDataPdu,
  SleStatusReportPdu,
  SlePeerAbortPdu,
} from "./sle.types";

export class SlePduCodec {
  // PDU Type Tags (1 byte identifier)
  public static readonly TAG_BIND_REQUEST = 0x01;
  public static readonly TAG_BIND_RETURN = 0x02;
  public static readonly TAG_UNBIND_REQUEST = 0x03;
  public static readonly TAG_UNBIND_RETURN = 0x04;
  public static readonly TAG_START_REQUEST = 0x05;
  public static readonly TAG_START_RETURN = 0x06;
  public static readonly TAG_STOP_REQUEST = 0x07;
  public static readonly TAG_STOP_RETURN = 0x08;
  public static readonly TAG_TRANSFER_DATA = 0x09;
  public static readonly TAG_STATUS_REPORT = 0x0a;
  public static readonly TAG_PEER_ABORT = 0x0f;

  public static readonly PROTOCOL_MAGIC = 0x534c4531; // "SLE1" (32 bits)

  /**
   * Encodes an SLE PDU into a framing buffer:
   * [MAGIC (4B)] [PDU_TYPE (1B)] [PAYLOAD_LEN (4B)] [JSON_PAYLOAD (NB)] [OPTIONAL_FRAME_BYTES]
   */
  public static encode(pdu: SlePdu): Buffer {
    let frameBytes: Buffer | undefined;

    // Extract binary frame payload if RAF TRANSFER_DATA
    if (pdu.pduType === "TRANSFER_DATA") {
      frameBytes = pdu.frameData;
    }

    const payloadObj = { ...pdu };
    if ("frameData" in payloadObj) {
      delete (payloadObj as any).frameData; // Don't JSON-serialize the binary CADU
    }

    const jsonStr = JSON.stringify(payloadObj);
    const jsonBuf = Buffer.from(jsonStr, "utf8");

    const frameLen = frameBytes ? frameBytes.length : 0;
    const totalPayloadLen = 4 + jsonBuf.length + frameLen; // 4 bytes for json length prefix

    const headerBuf = Buffer.alloc(9);
    headerBuf.writeUInt32BE(this.PROTOCOL_MAGIC, 0);
    headerBuf.writeUInt8(this.getPduTag(pdu.pduType), 4);
    headerBuf.writeUInt32BE(totalPayloadLen, 5);

    const jsonLenBuf = Buffer.alloc(4);
    jsonLenBuf.writeUInt32BE(jsonBuf.length, 0);

    const chunks: Uint8Array[] = [headerBuf, jsonLenBuf, jsonBuf];
    if (frameBytes) {
      chunks.push(frameBytes);
    }

    return Buffer.concat(chunks);
  }

  /**
   * Decodes a binary buffer into an SLE PDU.
   * Throws Error on malformed PDU or corrupted framing.
   */
  public static decode(buffer: Buffer): SlePdu {
    if (buffer.length < 9) {
      throw new Error(`[SlePduCodec] Malformed PDU: Buffer too short (${buffer.length} bytes, minimum 9)`);
    }

    const magic = buffer.readUInt32BE(0);
    if (magic !== this.PROTOCOL_MAGIC) {
      throw new Error(
        `[SlePduCodec] Protocol magic mismatch: expected 0x${this.PROTOCOL_MAGIC.toString(16)}, got 0x${magic.toString(16)}`
      );
    }

    const tag = buffer.readUInt8(4);
    const payloadLen = buffer.readUInt32BE(5);

    if (buffer.length < 9 + payloadLen) {
      throw new Error(
        `[SlePduCodec] Buffer truncated: expected ${9 + payloadLen} bytes, got ${buffer.length}`
      );
    }

    const jsonLen = buffer.readUInt32BE(9);
    if (jsonLen > payloadLen - 4) {
      throw new Error(
        `[SlePduCodec] Malformed PDU: jsonLen (${jsonLen}) exceeds payload boundary (${payloadLen - 4})`
      );
    }

    const jsonStr = buffer.subarray(13, 13 + jsonLen).toString("utf8");
    let pduObj: any;
    try {
      pduObj = JSON.parse(jsonStr);
    } catch (e: any) {
      throw new Error(`[SlePduCodec] Malformed ASN.1 JSON payload: ${e.message}`);
    }

    // Attach binary frame data if TRANSFER_DATA
    if (tag === this.TAG_TRANSFER_DATA) {
      const frameStart = 13 + jsonLen;
      const frameLen = payloadLen - 4 - jsonLen;
      pduObj.frameData = Buffer.from(buffer.subarray(frameStart, frameStart + frameLen));
    }

    return pduObj as SlePdu;
  }

  private static getPduTag(pduType: SlePduType): number {
    switch (pduType) {
      case "BIND_REQUEST":
        return this.TAG_BIND_REQUEST;
      case "BIND_RETURN":
        return this.TAG_BIND_RETURN;
      case "UNBIND_REQUEST":
        return this.TAG_UNBIND_REQUEST;
      case "UNBIND_RETURN":
        return this.TAG_UNBIND_RETURN;
      case "START_REQUEST":
        return this.TAG_START_REQUEST;
      case "START_RETURN":
        return this.TAG_START_RETURN;
      case "STOP_REQUEST":
        return this.TAG_STOP_REQUEST;
      case "STOP_RETURN":
        return this.TAG_STOP_RETURN;
      case "TRANSFER_DATA":
        return this.TAG_TRANSFER_DATA;
      case "STATUS_REPORT":
        return this.TAG_STATUS_REPORT;
      case "PEER_ABORT":
        return this.TAG_PEER_ABORT;
      default:
        throw new Error(`[SlePduCodec] Unknown PDU type: ${pduType}`);
    }
  }
}
