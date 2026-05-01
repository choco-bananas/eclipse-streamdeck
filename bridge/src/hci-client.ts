import net from "net";
import { EventEmitter } from "events";
import {
    buildPing,
    buildXptStatusRequest,
    buildLevelStatusRequest,
    parsePacket,
    parseXptStatus,
    parseLevelStatus,
    MSG_XPT_STATUS_REP,
    MSG_LEVEL_STATUS_REP,
    MSG_ACTIONS_STATUS_REP,
    MSG_BROADCAST,
    XptConnection,
    LevelEntry,
} from "./hci-protocol.js";

const RECONNECT_DELAY_MS  = 3000;
const PING_INTERVAL_MS    = 10000;
const PING_TIMEOUT_MS     = 5000;
const RECV_BUFFER_MAX     = 65536;

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface HciClientOptions {
    host: string;
    port: number;
}

export interface XptKey { src: number; dst: number; }

/**
 * HCI TCP client that maintains a persistent connection to Clear-Com Eclipse.
 * Emits events for connection state changes and incoming matrix status.
 *
 * Events:
 *   "state"        (state: ConnectionState)
 *   "xpt_status"   (connections: XptConnection[])
 *   "level_status" (entries: LevelEntry[])
 *   "log"          (msg: string)
 */
export class HciClient extends EventEmitter {
    private socket: net.Socket | null = null;
    private state: ConnectionState = "disconnected";
    private rxBuf = Buffer.allocUnsafe(0);
    private pingTimer: NodeJS.Timeout | null = null;
    private pingTimeoutTimer: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private stopped = false;

    constructor(private opts: HciClientOptions) {
        super();
    }

    getState(): ConnectionState { return this.state; }

    start(): void {
        this.stopped = false;
        this._connect();
    }

    stop(): void {
        this.stopped = true;
        this._clearTimers();
        this.socket?.destroy();
        this.socket = null;
        this._setState("disconnected");
    }

    send(buf: Buffer): boolean {
        if (this.state !== "connected" || !this.socket) return false;
        try {
            this.socket.write(buf);
            this.emit("log", `TX [${buf.length}B] ${buf.toString("hex")}`);
            return true;
        } catch (e) {
            this.emit("log", `TX error: ${e}`);
            return false;
        }
    }

    requestXptStatus(ports: number[]): void {
        this.send(buildXptStatusRequest(ports));
    }

    requestLevelStatus(dstPorts: number[]): void {
        this.send(buildLevelStatusRequest(dstPorts));
    }

    private _connect(): void {
        if (this.stopped) return;
        this._setState("connecting");
        this.emit("log", `Connecting to ${this.opts.host}:${this.opts.port}…`);

        const sock = new net.Socket();
        this.socket = sock;

        sock.setTimeout(5000);
        sock.connect(this.opts.port, this.opts.host, () => {
            sock.setTimeout(0);
            this._setState("connected");
            this.emit("log", `Connected to ${this.opts.host}:${this.opts.port}`);
            this._startPing();
        });

        sock.on("data", (chunk: Buffer) => this._onData(chunk));

        sock.on("timeout", () => {
            this.emit("log", "Connection timeout");
            sock.destroy();
        });

        sock.on("error", (err) => {
            this.emit("log", `Socket error: ${err.message}`);
        });

        sock.on("close", () => {
            this._clearPing();
            this._setState("disconnected");
            this.emit("log", "Disconnected");
            if (!this.stopped) this._scheduleReconnect();
        });
    }

    private _onData(chunk: Buffer): void {
        // Append to receive buffer
        this.rxBuf = Buffer.concat([this.rxBuf, chunk]);
        if (this.rxBuf.length > RECV_BUFFER_MAX) {
            this.rxBuf = this.rxBuf.slice(this.rxBuf.length - RECV_BUFFER_MAX);
        }

        // Process all complete packets in buffer
        while (this.rxBuf.length >= 6) {
            // Find start marker
            const startIdx = this._findStart(this.rxBuf);
            if (startIdx < 0) { this.rxBuf = Buffer.allocUnsafe(0); break; }
            if (startIdx > 0)  { this.rxBuf = this.rxBuf.slice(startIdx); }

            if (this.rxBuf.length < 4) break;
            const totalLen = this.rxBuf.readUInt16BE(2);
            if (totalLen < 6 || totalLen > 2048) {
                // Invalid length — skip start marker and retry
                this.rxBuf = this.rxBuf.slice(2);
                continue;
            }
            if (this.rxBuf.length < totalLen) break; // wait for more data

            const packet = this.rxBuf.slice(0, totalLen);
            this.rxBuf  = this.rxBuf.slice(totalLen);
            this._processPacket(packet);
        }
    }

    private _findStart(buf: Buffer): number {
        for (let i = 0; i < buf.length - 1; i++) {
            if (buf[i] === 0x5A && buf[i + 1] === 0x0F) return i;
        }
        return -1;
    }

    private _processPacket(data: Buffer): void {
        // Ignore ping echo (8 bytes)
        if (data.length === 8 && data[0] === 0x5A && data[1] === 0x0F) {
            this._onPingEcho();
            return;
        }

        const parsed = parsePacket(data);
        if (!parsed) {
            this.emit("log", `RX unparseable [${data.length}B] ${data.slice(0, 16).toString("hex")}`);
            return;
        }

        const { msgId, payload } = parsed;
        this.emit("log", `RX msgId=0x${msgId.toString(16).padStart(4, "0")} [${data.length}B]`);

        switch (msgId) {
            case MSG_XPT_STATUS_REP: {
                const conns = parseXptStatus(payload);
                this.emit("xpt_status", conns);
                break;
            }
            case MSG_LEVEL_STATUS_REP: {
                const entries = parseLevelStatus(payload);
                this.emit("level_status", entries);
                break;
            }
            case MSG_ACTIONS_STATUS_REP:
                // Action confirmation — could parse and emit if needed
                break;
            case MSG_BROADCAST:
                // Informational text from CSU
                break;
        }
    }

    // ── Ping ────────────────────────────────────────────────────────────────

    private _startPing(): void {
        this._clearPing();
        this.pingTimer = setInterval(() => this._sendPing(), PING_INTERVAL_MS);
    }

    private _sendPing(): void {
        if (!this.send(buildPing())) return;
        this.pingTimeoutTimer = setTimeout(() => {
            this.emit("log", "Ping timeout — closing socket");
            this.socket?.destroy();
        }, PING_TIMEOUT_MS);
    }

    private _onPingEcho(): void {
        if (this.pingTimeoutTimer) {
            clearTimeout(this.pingTimeoutTimer);
            this.pingTimeoutTimer = null;
        }
    }

    private _clearPing(): void {
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
        if (this.pingTimeoutTimer) { clearTimeout(this.pingTimeoutTimer); this.pingTimeoutTimer = null; }
    }

    // ── Reconnect ────────────────────────────────────────────────────────────

    private _scheduleReconnect(): void {
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this._connect();
        }, RECONNECT_DELAY_MS);
    }

    private _clearTimers(): void {
        this._clearPing();
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    }

    private _setState(s: ConnectionState): void {
        if (this.state !== s) {
            this.state = s;
            this.emit("state", s);
        }
    }
}
