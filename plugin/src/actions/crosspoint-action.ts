import streamDeck, {
    action,
    KeyDownEvent,
    WillAppearEvent,
    WillDisappearEvent,
    SingletonAction,
    KeyAction,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { hci } from "../hci/client.js";
import { buildXptAction, XptStatusEntry } from "../hci/protocol.js";

// ── Settings ──────────────────────────────────────────────────────────────────

export interface CrosspointSettings {
    srcPort: number;
    dstPort: number;
    label: string;
    [key: string]: JsonValue;
}

// ── In-memory XPT state  key="src:dst" (0-based) ────────────────────────────

const xptState = new Map<string, boolean>();
const xk = (src: number, dst: number) => `${src}:${dst}`;

// ── Module-level helpers ──────────────────────────────────────────────────────

function xptLabel(s: CrosspointSettings, active: boolean): string {
    const base = s.label || `${s.srcPort ?? "?"}→${s.dstPort ?? "?"}`;
    return `${base}\n${active ? "■ ON" : "□ OFF"}`;
}

async function refreshXpt(act: KeyAction<CrosspointSettings>, s: CrosspointSettings): Promise<void> {
    if (!s?.srcPort || !s?.dstPort) return;
    const src = s.srcPort - 1;
    const dst = s.dstPort - 1;
    const active = xptState.get(xk(src, dst)) ?? false;
    await act.setState(active ? 1 : 0);
    await act.setTitle(xptLabel(s, active));
    hci.requestXptStatus([dst]);
}

// ── Action ────────────────────────────────────────────────────────────────────

@action({ UUID: "com.mtcjapan.eclipsehci.crosspoint" })
export class CrosspointAction extends SingletonAction<CrosspointSettings> {

    override async onWillAppear(ev: WillAppearEvent<CrosspointSettings>): Promise<void> {
        await refreshXpt(ev.action as KeyAction<CrosspointSettings>, ev.payload.settings);
    }

    override onWillDisappear(_ev: WillDisappearEvent<CrosspointSettings>): void {}

    override async onKeyDown(ev: KeyDownEvent<CrosspointSettings>): Promise<void> {
        const s = ev.payload.settings;
        if (!s?.srcPort || !s?.dstPort) { await ev.action.showAlert(); return; }

        const src = s.srcPort - 1;
        const dst = s.dstPort - 1;
        const key = xk(src, dst);
        const newDir = !(xptState.get(key) ?? false);

        if (!hci.send(buildXptAction([{ src, dst }], newDir))) {
            await ev.action.showAlert();
            return;
        }

        xptState.set(key, newDir);
        await ev.action.setState(newDir ? 1 : 0);
        await ev.action.setTitle(xptLabel(s, newDir));
    }
}

// ── Called from plugin.ts when matrix reports XPT status change ──────────────

export function applyXptStatus(entries: XptStatusEntry[]): void {
    for (const entry of entries) {
        for (const conn of entry.connections) {
            const isOn = conn.isTalker || conn.isListener;
            xptState.set(xk(conn.port, entry.monitoredPort), isOn);
            for (const act of streamDeck.actions) {
                if (act.manifestId !== "com.mtcjapan.eclipsehci.crosspoint") continue;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (act as any).getSettings().then(async (s: CrosspointSettings) => {
                    if ((s.srcPort - 1) === conn.port && (s.dstPort - 1) === entry.monitoredPort) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const keyAct = act as any as KeyAction<CrosspointSettings>;
                        await keyAct.setState(isOn ? 1 : 0);
                        await keyAct.setTitle(xptLabel(s, isOn));
                    }
                }).catch(() => undefined);
            }
        }
    }
}
