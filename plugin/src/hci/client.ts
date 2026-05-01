import net from "net";
import { EventEmitter } from "events";
import {
    buildPing, buildXptStatusRequest, buildLevelStatusRequest,
    parsePacket, parseXptStatus, parseLevelStatus,
    MSG_XPT_STATUS_REP, MSG_LEVEL_STATUS_REP,
    XptStatusEntry, LevelEntry,
} from "./protocol.js";

const RECONNECT_MS  = 4000;
const PING_INTERVAL = 15000;
const PING_TIMEOUT  = 5000;

export type HciState = "disconnected" | "connecting" | "connected";

export class HciManager extends EventEmitter {
    private sock: net.Socket | null = null;
    private rxBuf = Buffer.allocUnsafe(0);
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private pingTmo:   ReturnType<typeof setTimeout>  | null = null;
    private reconnTmo: ReturnType<typeof setTimeout>  | null = null;
    private _state: HciState = "disconnected";
    private _host = "";
    private _port = 0;
    private _active = false;

    get state(): HciState { return this._state; }

    connect(host: string, port: number): void {
        this._host   = host;
        this._port   = port;
        this._active = true;
        this._doConnect();
    }

    disconnect(): void {
        this._active = false;
        this._clearAll();
        this.sock?.destroy();
        this.sock = null;
        this._setState("disconnected");
    }

    send(buf: Buffer): boolean {
        if (this._state !== "connected" || !this.sock) return false;
        try { this.sock.write(buf); return true; }
        catch { return false; }
    }

    requestXptStatus(ports: number[]): void  { this.send(buildXptStatusRequest(ports)); }
    requestLevelStatus(ports: number[]): void { this.send(buildLevelStatusRequest(ports)); }

    // ── Internal ────────────────────────────────────────────────────────────

    private _doConnect(): void {
        if (!this._active) return;
        this._setState("connecting");
        const sock = new net.Socket();
        this.sock = sock;
        sock.setTimeout(5000);
        sock.connect(this._port, this._host, () => {
            sock.setTimeout(0);
            this._setState("connected");
            this._startPing();
        });
        sock.on("data", (c: Buffer) => this._onData(c));
        sock.on("timeout", () => sock.destroy());
        sock.on("error",   () => { /* handled in close */ });
        sock.on("close", () => {
            this._clearPing();
            this._setState("disconnected");
            if (this._active) this.reconnTmo = setTimeout(() => this._doConnect(), RECONNECT_MS);
        });
    }

    private _onData(chunk: Buffer): void {
        this.rxBuf = Buffer.concat([this.rxBuf, chunk]);
        if (this.rxBuf.length > 65536) this.rxBuf = this.rxBuf.slice(-65536);

        while (this.rxBuf.length >= 6) {
            // Find start marker
            let si = -1;
            for (let i = 0; i < this.rxBuf.length - 1; i++) {
                if (this.rxBuf[i] === 0x5A && this.rxBuf[i + 1] === 0x0F) { si = i; break; }
            }
            if (si < 0)  { this.rxBuf = Buffer.allocUnsafe(0); break; }
            if (si > 0)  { this.rxBuf = this.rxBuf.slice(si); }
            if (this.rxBuf.length < 4) break;

            const len = this.rxBuf.readUInt16BE(2);
            if (len < 6 || len > 4096) { this.rxBuf = this.rxBuf.slice(2); continue; }
            if (this.rxBuf.length < len) break;

            this._processPacket(this.rxBuf.slice(0, len));
            this.rxBuf = this.rxBuf.slice(len);
        }
    }

    private _processPacket(data: Buffer): void {
        // Ping echo (8 bytes)
        if (data.length <= 12 && data[0] === 0x5A && data[1] === 0x0F) {
            if (this.pingTmo) { clearTimeout(this.pingTmo); this.pingTmo = null; }
            return;
        }
        const pkt = parsePacket(data);
        if (!pkt) return;
        if (pkt.msgId === MSG_XPT_STATUS_REP)   this.emit("xpt_status",   parseXptStatus(pkt.payload));
        if (pkt.msgId === MSG_LEVEL_STATUS_REP)  this.emit("level_status", parseLevelStatus(pkt.payload));
    }

    private _startPing(): void {
        this._clearPing();
        this.pingTimer = setInterval(() => {
            if (this.send(buildPing())) {
                this.pingTmo = setTimeout(() => this.sock?.destroy(), PING_TIMEOUT);
            }
        }, PING_INTERVAL);
    }

    private _clearPing(): void {
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
        if (this.pingTmo)   { clearTimeout(this.pingTmo);   this.pingTmo   = null; }
    }

    private _clearAll(): void {
        this._clearPing();
        if (this.reconnTmo) { clearTimeout(this.reconnTmo); this.reconnTmo = null; }
    }

    private _setState(s: HciState): void {
        if (this._state !== s) { this._state = s; this.emit("state", s); }
    }
}

// Singleton shared across all actions in the plugin process
export const hci = new HciManager();
