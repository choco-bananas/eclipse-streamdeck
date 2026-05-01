/**
 * HCI Bridge WebSocket Server
 *
 * Connects to Clear-Com Eclipse via TCP (HCI 2.0) and exposes a WebSocket API
 * so that the Stream Deck plugin (or any other client) can control crosspoints
 * and levels without managing the raw TCP connection themselves.
 *
 * WebSocket port: 8765 (configurable via WS_PORT env var)
 * Eclipse host/port: configurable via ECLIPSE_HOST / ECLIPSE_PORT env vars
 *   or set dynamically via {"cmd":"connect",...} message.
 *
 * ── Client→Bridge messages ────────────────────────────────────────────────
 * {"cmd":"connect",   "host":"192.168.1.10","port":52001}
 * {"cmd":"disconnect"}
 * {"cmd":"xpt",       "src":0,"dst":1,"direction":true}   // direction: true=Make false=Break
 * {"cmd":"level",     "src":0,"dst":1,"db":0}             // db: -72..+18
 * {"cmd":"get_xpt",   "ports":[0,1,2]}                    // request status for ports
 * {"cmd":"get_level", "ports":[0,1]}                      // request level for dst ports
 * {"cmd":"status"}                                        // query bridge state
 *
 * ── Bridge→Client messages ────────────────────────────────────────────────
 * {"type":"state",        "state":"connected"|"connecting"|"disconnected"}
 * {"type":"xpt_status",   "connections":[{"monitoredPort":0,"connections":[...]}]}
 * {"type":"level_status", "entries":[{"dstPort":0,"srcPort":1,"level":204,"db":0}]}
 * {"type":"log",          "msg":"..."}
 * {"type":"error",        "msg":"..."}
 */

import { WebSocketServer, WebSocket } from "ws";
import { HciClient } from "./hci-client.js";
import {
    buildXptAction,
    buildLevelAction,
    dbToLevel,
    XptPair,
} from "./hci-protocol.js";

const WS_PORT      = parseInt(process.env["WS_PORT"]  ?? "8765");
const ECLIPSE_HOST = process.env["ECLIPSE_HOST"] ?? "192.168.1.10";
const ECLIPSE_PORT = parseInt(process.env["ECLIPSE_PORT"] ?? "52001");

// ── State ────────────────────────────────────────────────────────────────────

// In-memory crosspoint & level state cache
// Key: "src:dst"
const xptCache   = new Map<string, boolean>();   // true = active
const levelCache = new Map<string, number>();     // dB value

let hciClient: HciClient | null = null;
const clients = new Set<WebSocket>();

function xptKey(src: number, dst: number): string { return `${src}:${dst}`; }

// ── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: WS_PORT });
console.log(`HCI Bridge WebSocket server listening on ws://localhost:${WS_PORT}`);
console.log(`Default Eclipse target: ${ECLIPSE_HOST}:${ECLIPSE_PORT}`);

wss.on("connection", (ws) => {
    clients.add(ws);
    console.log(`WS client connected (total: ${clients.size})`);

    // Send current bridge state to new client
    if (hciClient) {
        send(ws, { type: "state", state: hciClient.getState() });
    } else {
        send(ws, { type: "state", state: "disconnected" });
    }

    ws.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(raw.toString()); }
        catch { send(ws, { type: "error", msg: "Invalid JSON" }); return; }
        handleClientMessage(ws, msg);
    });

    ws.on("close", () => {
        clients.delete(ws);
        console.log(`WS client disconnected (total: ${clients.size})`);
    });

    ws.on("error", (e) => console.error("WS error:", e));
});

// ── Message Handler ───────────────────────────────────────────────────────────

function handleClientMessage(ws: WebSocket, msg: Record<string, unknown>): void {
    switch (msg["cmd"]) {

        case "connect": {
            const host = (msg["host"] as string | undefined) ?? ECLIPSE_HOST;
            const port = (msg["port"] as number | undefined) ?? ECLIPSE_PORT;
            startHci(host, port);
            send(ws, { type: "state", state: hciClient?.getState() ?? "connecting" });
            break;
        }

        case "disconnect": {
            hciClient?.stop();
            hciClient = null;
            broadcast({ type: "state", state: "disconnected" });
            break;
        }

        case "xpt": {
            const src = Number(msg["src"]);
            const dst = Number(msg["dst"]);
            const dir = msg["direction"] !== false; // default true (Make)
            if (!hciClient) { send(ws, { type: "error", msg: "Not connected" }); return; }
            hciClient.send(buildXptAction([{ src, dst }], dir));
            xptCache.set(xptKey(src, dst), dir);
            broadcast({ type: "xpt_local", src, dst, active: dir });
            break;
        }

        case "level": {
            const src = Number(msg["src"]);
            const dst = Number(msg["dst"]);
            const db  = Number(msg["db"] ?? 0);
            if (!hciClient) { send(ws, { type: "error", msg: "Not connected" }); return; }
            hciClient.send(buildLevelAction(src, dst, db));
            levelCache.set(xptKey(src, dst), db);
            broadcast({ type: "level_local", src, dst, db });
            break;
        }

        case "get_xpt": {
            const ports = (msg["ports"] as number[] | undefined) ?? [];
            hciClient?.requestXptStatus(ports);
            break;
        }

        case "get_level": {
            const ports = (msg["ports"] as number[] | undefined) ?? [];
            hciClient?.requestLevelStatus(ports);
            break;
        }

        case "status": {
            send(ws, {
                type: "status",
                hci_state: hciClient?.getState() ?? "disconnected",
                xpt_cache: Object.fromEntries(xptCache),
                level_cache: Object.fromEntries(levelCache),
            });
            break;
        }

        default:
            send(ws, { type: "error", msg: `Unknown command: ${msg["cmd"]}` });
    }
}

// ── HCI Client Management ─────────────────────────────────────────────────────

function startHci(host: string, port: number): void {
    if (hciClient) { hciClient.stop(); }

    hciClient = new HciClient({ host, port });

    hciClient.on("state", (state: string) => {
        console.log(`Eclipse HCI state: ${state}`);
        broadcast({ type: "state", state });
    });

    hciClient.on("xpt_status", (connections: unknown[]) => {
        broadcast({ type: "xpt_status", connections });
    });

    hciClient.on("level_status", (entries: unknown[]) => {
        // Update level cache
        for (const e of entries as Array<{ srcPort: number; dstPort: number; db: number }>) {
            levelCache.set(xptKey(e.srcPort, e.dstPort), e.db);
        }
        broadcast({ type: "level_status", entries });
    });

    hciClient.on("log", (msg: string) => {
        broadcast({ type: "log", msg });
    });

    hciClient.start();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(ws: WebSocket, data: object): void {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function broadcast(data: object): void {
    const json = JSON.stringify(data);
    for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
}

// ── Auto-start with env vars ─────────────────────────────────────────────────
if (ECLIPSE_HOST !== "192.168.1.10") {
    // If host was explicitly set via env, connect automatically
    startHci(ECLIPSE_HOST, ECLIPSE_PORT);
}

process.on("SIGINT", () => {
    console.log("\nShutting down bridge…");
    hciClient?.stop();
    wss.close();
    process.exit(0);
});
