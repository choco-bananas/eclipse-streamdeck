/**
 * HCI 2.0 Protocol – packet builders and parsers
 * Port of eclipse_hci_gui.py logic into TypeScript
 */

export const HCI_START  = 0x5A0F;
export const HCI_END    = 0x2E8D;
export const HCI_MAGIC  = 0xABBACEDE;
export const HCI_FLAGS  = 0x08;
export const HCI_SCHEMA = 0x01;

export const MSG_XPT_ACTION       = 0x0011;
export const MSG_XPT_STATUS_REQ   = 0x000D;
export const MSG_XPT_STATUS_REP   = 0x000E;
export const MSG_LEVEL_ACTION     = 0x0026;
export const MSG_LEVEL_STATUS_REQ = 0x0027;
export const MSG_LEVEL_STATUS_REP = 0x0028;
export const MSG_ACTIONS_STATUS   = 0x0010;

export const LEVEL_0DB = 204;

/** Discrete gain steps available in HCI (dB values) */
export const DB_LEVELS = [
    18, 15, 12, 9, 6, 5, 4, 3, 2, 1, 0,
    -1, -2, -3, -4, -5, -6, -7, -8, -9, -10,
    -12, -14, -16, -20, -35, -45, -72,
];

export function dbToLevel(db: number): number {
    return Math.max(1, Math.min(287, Math.round(204 + db / 0.355)));
}
export function levelToDb(level: number): number {
    return Math.round((level - 204) * 0.355 * 10) / 10;
}

function hdr(buf: Buffer, totalSize: number, msgId: number): number {
    let o = 0;
    buf.writeUInt16BE(HCI_START, o); o += 2;
    buf.writeUInt16BE(totalSize, o); o += 2;
    buf.writeUInt16BE(msgId,     o); o += 2;
    buf.writeUInt8(HCI_FLAGS,    o); o += 1;
    buf.writeUInt32BE(HCI_MAGIC, o); o += 4;
    buf.writeUInt8(HCI_SCHEMA,   o); o += 1;
    return o; // 12
}

export interface XptPair { src: number; dst: number; }

export function buildXptAction(xpts: XptPair[], direction = true, enable = true): Buffer {
    const n = xpts.length;
    const total = 12 + 2 + n * 10 + 2;
    const buf = Buffer.allocUnsafe(total);
    let o = hdr(buf, total, MSG_XPT_ACTION);
    buf.writeUInt16BE(n, o); o += 2;
    for (const { src, dst } of xpts) {
        const dh = (dst >> 8) & 0x03, dl = dst & 0xFF;
        const sh = (src >> 8) & 0x03, sl = src & 0xFF;
        const w0 = 9216 + (direction ? 1 : 0) + (dh << 1) + (sh << 8);
        const w1 = (sl << 8) + dl;
        const w3 = 1018 + ((enable ? 0 : 1) << 11) + (3 << 13);
        buf.writeUInt16BE(1,  o); o += 2;
        buf.writeUInt16BE(w0, o); o += 2;
        buf.writeUInt16BE(w1, o); o += 2;
        buf.writeUInt16BE(0,  o); o += 2;
        buf.writeUInt16BE(w3, o); o += 2;
    }
    buf.writeUInt16BE(HCI_END, o);
    return buf;
}

export function buildLevelAction(src: number, dst: number, db: number): Buffer {
    const level = dbToLevel(db);
    const total = 22;
    const buf = Buffer.allocUnsafe(total);
    let o = hdr(buf, total, MSG_LEVEL_ACTION);
    buf.writeUInt16BE(1,     o); o += 2;
    buf.writeUInt16BE(dst,   o); o += 2;
    buf.writeUInt16BE(src,   o); o += 2;
    buf.writeUInt16BE(level, o); o += 2;
    buf.writeUInt16BE(HCI_END, o);
    return buf;
}

export function buildXptStatusRequest(ports: number[]): Buffer {
    const total = 12 + 2 + ports.length * 2 + 2;
    const buf = Buffer.allocUnsafe(total);
    let o = hdr(buf, total, MSG_XPT_STATUS_REQ);
    buf.writeUInt16BE(ports.length, o); o += 2;
    for (const p of ports) { buf.writeUInt16BE(p, o); o += 2; }
    buf.writeUInt16BE(HCI_END, o);
    return buf;
}

export function buildLevelStatusRequest(dstPorts: number[]): Buffer {
    const total = 12 + 2 + dstPorts.length * 2 + 2;
    const buf = Buffer.allocUnsafe(total);
    let o = hdr(buf, total, MSG_LEVEL_STATUS_REQ);
    buf.writeUInt16BE(dstPorts.length, o); o += 2;
    for (const p of dstPorts) { buf.writeUInt16BE(p, o); o += 2; }
    buf.writeUInt16BE(HCI_END, o);
    return buf;
}

export function buildPing(): Buffer {
    return Buffer.from([0x5A, 0x0F, 0x00, 0x10, 0x00, 0x00, 0x2E, 0x8D]);
}

export interface ParsedPacket { msgId: number; payload: Buffer; }

export function parsePacket(data: Buffer): ParsedPacket | null {
    if (data.length < 14) return null;
    if (data.readUInt16BE(0) !== HCI_START) return null;
    const total = data.readUInt16BE(2);
    if (data.length < total || total < 14) return null;
    if (data.readUInt32BE(7) !== HCI_MAGIC) return null;
    return { msgId: data.readUInt16BE(4), payload: data.slice(12, total - 2) };
}

export interface XptStatusEntry {
    monitoredPort: number;
    connections: Array<{ port: number; isTalker: boolean; isListener: boolean }>;
}
export function parseXptStatus(payload: Buffer): XptStatusEntry[] {
    const results: XptStatusEntry[] = [];
    if (payload.length < 2) return results;
    const count = payload.readUInt16BE(0);
    let o = 2, cur: XptStatusEntry | null = null;
    for (let i = 0; i < count && o + 2 <= payload.length; i++) {
        const w = payload.readUInt16BE(o); o += 2;
        if (w & 0x8000) {
            cur = { monitoredPort: w & 0x1FFF, connections: [] };
            results.push(cur);
        } else if (cur) {
            cur.connections.push({ port: w & 0x1FFF, isTalker: !!(w & 0x4000), isListener: !!(w & 0x2000) });
        }
    }
    return results;
}

export interface LevelEntry { dstPort: number; srcPort: number; level: number; db: number; }
export function parseLevelStatus(payload: Buffer): LevelEntry[] {
    const results: LevelEntry[] = [];
    if (payload.length < 4) return results;
    const count = payload.readUInt16BE(0), dstPort = payload.readUInt16BE(2);
    let o = 4;
    for (let i = 0; i < count && o + 4 <= payload.length; i++) {
        const srcPort = payload.readUInt16BE(o); o += 2;
        const level   = payload.readUInt16BE(o); o += 2;
        results.push({ dstPort, srcPort, level, db: levelToDb(level) });
    }
    return results;
}
