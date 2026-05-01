/**
 * Clear-Com Eclipse HCI 2.0 Protocol Implementation
 * Based on: HCI Reference 399G175 Rev F (20 Nov 2024)
 *
 * Packet structure: [Start=0x5A0F (2B)][TotalLength (2B)][MsgID (2B)][Flags (1B)]
 *                   [Magic=0xABBACEDE (4B)][Schema=0x01 (1B)][Data...][End=0x2E8D (2B)]
 *
 * Port numbers are 0-based in HCI. EHX Port 1 = HCI Port 0.
 */

export const HCI_START  = 0x5A0F;
export const HCI_END    = 0x2E8D;
export const HCI_MAGIC  = 0xABBACEDE;
export const HCI_FLAGS  = 0x08;   // G-bit set (host→CSU)
export const HCI_SCHEMA = 0x01;

// Message IDs
export const MSG_XPT_ACTION     = 0x0011; // 17  Request Crosspoint Actions
export const MSG_XPT_STATUS_REQ = 0x000D; // 13  Request Crosspoint Status
export const MSG_XPT_STATUS_REP = 0x000E; // 14  Reply Crosspoint Status
export const MSG_LEVEL_ACTION   = 0x0026; // 38  Request Crosspoint Level Actions
export const MSG_LEVEL_STATUS_REQ = 0x0027; // 39 Request Crosspoint Level Status
export const MSG_LEVEL_STATUS_REP = 0x0028; // 40 Reply Crosspoint Level Status
export const MSG_ACTIONS_STATUS_REP = 0x0010; // 16 Reply Actions Status
export const MSG_BROADCAST      = 0x0001; // 1  Broadcast System Message

// Gain level table (Appendix A)
// gain_dB = (level_value - 204) * 0.355
export const DB_LEVELS = [18,15,12,9,6,5,4,3,2,1,0,-1,-2,-3,-4,-5,-6,-7,-8,-9,-10,-12,-14,-16,-20,-35,-45,-72];
export const LEVEL_0DB = 204;   // 0dB = 0xCC

export function dbToLevel(db: number): number {
    const lvl = Math.round(204 + db / 0.355);
    return Math.max(1, Math.min(287, lvl));
}

export function levelToDb(level: number): number {
    return Math.round((level - 204) * 0.355 * 10) / 10;
}

/** Write common HCI header into buffer, return bytes written (12) */
function writeHeader(buf: Buffer, totalSize: number, msgId: number): number {
    let off = 0;
    buf.writeUInt16BE(HCI_START,  off); off += 2;
    buf.writeUInt16BE(totalSize,  off); off += 2;
    buf.writeUInt16BE(msgId,      off); off += 2;
    buf.writeUInt8(HCI_FLAGS,     off); off += 1;
    buf.writeUInt32BE(HCI_MAGIC,  off); off += 4;
    buf.writeUInt8(HCI_SCHEMA,    off); off += 1;
    return off; // 12
}

// ── Crosspoint Action ─────────────────────────────────────────────────────────

export interface XptPair { src: number; dst: number; }

/**
 * Build Request Crosspoint Actions packet.
 * @param xpts  Array of {src, dst} port pairs (0-based)
 * @param direction  true = add/enable (Make), false = delete/disable (Break)
 * @param enable     true = enable, false = inhibit
 */
export function buildXptAction(xpts: XptPair[], direction = true, enable = true): Buffer {
    const count = xpts.length;
    // header(12) + count(2) + N×[type(2)+W0(2)+W1(2)+W2(2)+W3(2)] + end(2)
    const totalSize = 12 + 2 + count * 10 + 2;
    const buf = Buffer.allocUnsafe(totalSize);
    let off = writeHeader(buf, totalSize, MSG_XPT_ACTION);

    buf.writeUInt16BE(count, off); off += 2;

    for (const { src, dst } of xpts) {
        const dh = (dst >> 8) & 0x03;
        const dl =  dst & 0xFF;
        const sh = (src >> 8) & 0x03;
        const sl =  src & 0xFF;

        // Word 0: bit0=direction, bits1-2=dst_msb, bit10=1, bit13=1, bits8-9=src_msb
        const word0 = 9216 + (direction ? 1 : 0) + (dh << 1) + (sh << 8);
        // Word 1: bits8-15=src_lsb, bits0-7=dst_lsb
        const word1 = (sl << 8) + dl;
        const word2 = 0;
        // Word 3: bit1=1, bits3-9=1(=0x7E), bit11=inhibit, bits13-15=priority(3)
        const word3 = 1018 + ((enable ? 0 : 1) << 11) + (3 << 13);

        buf.writeUInt16BE(1,     off); off += 2; // action type = 1 (XPT)
        buf.writeUInt16BE(word0, off); off += 2;
        buf.writeUInt16BE(word1, off); off += 2;
        buf.writeUInt16BE(word2, off); off += 2;
        buf.writeUInt16BE(word3, off); off += 2;
    }

    buf.writeUInt16BE(HCI_END, off);
    return buf;
}

// ── Crosspoint Level Action ───────────────────────────────────────────────────

/**
 * Build Request Crosspoint Level Actions packet.
 * @param src    Source port (0-based)
 * @param dst    Destination port (0-based)
 * @param db     Gain in dB (e.g. 0, +6, -6)
 */
export function buildLevelAction(src: number, dst: number, db: number): Buffer {
    const level = dbToLevel(db);
    // header(12) + count(2) + dst(2) + src(2) + level(2) + end(2) = 22
    const totalSize = 22;
    const buf = Buffer.allocUnsafe(totalSize);
    let off = writeHeader(buf, totalSize, MSG_LEVEL_ACTION);

    buf.writeUInt16BE(1,     off); off += 2; // count
    buf.writeUInt16BE(dst,   off); off += 2;
    buf.writeUInt16BE(src,   off); off += 2;
    buf.writeUInt16BE(level, off); off += 2;
    buf.writeUInt16BE(HCI_END, off);
    return buf;
}

// ── Crosspoint Status Request ─────────────────────────────────────────────────

/** Request current crosspoint status for given ports (0-based) */
export function buildXptStatusRequest(ports: number[]): Buffer {
    const count = ports.length;
    // header(12) + count(2) + N×port(2) + end(2)
    const totalSize = 12 + 2 + count * 2 + 2;
    const buf = Buffer.allocUnsafe(totalSize);
    let off = writeHeader(buf, totalSize, MSG_XPT_STATUS_REQ);

    buf.writeUInt16BE(count, off); off += 2;
    for (const p of ports) {
        buf.writeUInt16BE(p, off); off += 2;
    }
    buf.writeUInt16BE(HCI_END, off);
    return buf;
}

/** Request current crosspoint level status for a destination port */
export function buildLevelStatusRequest(dstPorts: number[]): Buffer {
    const count = dstPorts.length;
    const totalSize = 12 + 2 + count * 2 + 2;
    const buf = Buffer.allocUnsafe(totalSize);
    let off = writeHeader(buf, totalSize, MSG_LEVEL_STATUS_REQ);

    buf.writeUInt16BE(count, off); off += 2;
    for (const p of dstPorts) {
        buf.writeUInt16BE(p, off); off += 2;
    }
    buf.writeUInt16BE(HCI_END, off);
    return buf;
}

/** HCI ping packet: echoed back by CSU to confirm it is alive */
export function buildPing(): Buffer {
    return Buffer.from([0x5A, 0x0F, 0x00, 0x10, 0x00, 0x00, 0x2E, 0x8D]);
}

// ── Incoming Packet Parser ────────────────────────────────────────────────────

export interface ParsedPacket {
    msgId: number;
    flags: number;
    /** Raw payload bytes (after schema byte, before End marker) */
    payload: Buffer;
}

export function parsePacket(data: Buffer): ParsedPacket | null {
    if (data.length < 14) return null;
    const start = data.readUInt16BE(0);
    if (start !== HCI_START) return null;

    const totalLen = data.readUInt16BE(2);
    if (data.length < totalLen) return null;

    const msgId  = data.readUInt16BE(4);
    const flags  = data.readUInt8(6);
    const magic  = data.readUInt32BE(7);
    if (magic !== HCI_MAGIC) return null;

    // payload starts after header (12 bytes), ends before End marker (2 bytes)
    const payload = data.slice(12, totalLen - 2);
    return { msgId, flags, payload };
}

// ── Reply Parsers ─────────────────────────────────────────────────────────────

export interface XptConnection {
    monitoredPort: number;
    connections: Array<{ port: number; isTalker: boolean; isListener: boolean }>;
}

/** Parse Reply Crosspoint Status (0x000E) payload */
export function parseXptStatus(payload: Buffer): XptConnection[] {
    const results: XptConnection[] = [];
    if (payload.length < 2) return results;

    const count = payload.readUInt16BE(0);
    let off = 2;
    let current: XptConnection | null = null;

    for (let i = 0; i < count && off + 2 <= payload.length; i++) {
        const word = payload.readUInt16BE(off); off += 2;
        const isMonitored = (word & 0x8000) !== 0;
        const portNum = word & 0x1FFF;

        if (isMonitored) {
            current = { monitoredPort: portNum, connections: [] };
            results.push(current);
        } else if (current) {
            const isTalker   = (word & 0x4000) !== 0;
            const isListener = (word & 0x2000) !== 0;
            current.connections.push({ port: portNum, isTalker, isListener });
        }
    }
    return results;
}

export interface LevelEntry {
    dstPort: number;
    srcPort: number;
    level: number;
    db: number;
}

/** Parse Reply Crosspoint Level Status (0x0028) payload */
export function parseLevelStatus(payload: Buffer): LevelEntry[] {
    const results: LevelEntry[] = [];
    if (payload.length < 4) return results;

    const count   = payload.readUInt16BE(0);
    const dstPort = payload.readUInt16BE(2);
    let off = 4;

    for (let i = 0; i < count && off + 4 <= payload.length; i++) {
        const srcPort = payload.readUInt16BE(off); off += 2;
        const level   = payload.readUInt16BE(off); off += 2;
        results.push({ dstPort, srcPort, level, db: levelToDb(level) });
    }
    return results;
}
