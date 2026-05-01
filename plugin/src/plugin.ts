/**
 * Clear-Com Eclipse HCI – Stream Deck Plugin
 *
 * Global settings (stored via Stream Deck settings API – NO localStorage):
 *   { eclipseHost: string, eclipsePort: number, wsPort: number }
 *
 * Architecture:
 *   - One HCI TCP connection per plugin process (singleton `hci`)
 *   - HCI client auto-reconnects; all actions share the connection
 *   - XPT and level state held in-memory maps in action files
 */

import streamDeck from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { hci } from "./hci/client.js";
import { CrosspointAction, applyXptStatus } from "./actions/crosspoint-action.js";
import { LevelAction, applyLevelStatus } from "./actions/level-action.js";
import { XptStatusEntry, LevelEntry } from "./hci/protocol.js";

// ── Global settings type ──────────────────────────────────────────────────────

interface GlobalSettings {
    eclipseHost: string;
    eclipsePort: number;
    [key: string]: JsonValue;
}

const DEFAULT_HOST = "192.168.1.10";
const DEFAULT_PORT = 52001;

// ── HCI event wiring ──────────────────────────────────────────────────────────

hci.on("state", (state: string) => {
    streamDeck.logger.info(`Eclipse HCI state: ${state}`);
});

hci.on("xpt_status", (entries: XptStatusEntry[]) => {
    applyXptStatus(entries);
});

hci.on("level_status", (entries: LevelEntry[]) => {
    applyLevelStatus(entries);
});

// ── Register actions ──────────────────────────────────────────────────────────

streamDeck.actions.registerAction(new CrosspointAction());
streamDeck.actions.registerAction(new LevelAction());

// ── Connect to Eclipse when global settings are available ─────────────────────

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
    const { eclipseHost, eclipsePort } = ev.settings;
    const host = eclipseHost || DEFAULT_HOST;
    const port = eclipsePort || DEFAULT_PORT;
    streamDeck.logger.info(`Connecting to Eclipse at ${host}:${port}`);
    hci.connect(host, port);
});

// Request global settings on startup – triggers onDidReceiveGlobalSettings
streamDeck.settings.getGlobalSettings<GlobalSettings>().then((settings) => {
    const host = settings?.eclipseHost || DEFAULT_HOST;
    const port = settings?.eclipsePort || DEFAULT_PORT;
    streamDeck.logger.info(`Startup: connecting to Eclipse at ${host}:${port}`);
    hci.connect(host, port);
}).catch(() => {
    // Fall back to defaults if settings not yet configured
    streamDeck.logger.warn("Global settings not found – using defaults");
    hci.connect(DEFAULT_HOST, DEFAULT_PORT);
});

// ── Start ─────────────────────────────────────────────────────────────────────

streamDeck.connect();
