import streamDeck, {
    action,
    DialRotateEvent,
    DialDownEvent,
    TouchTapEvent,
    WillAppearEvent,
    WillDisappearEvent,
    SingletonAction,
    DialAction,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { hci } from "../hci/client.js";
import { buildLevelAction, DB_LEVELS, LevelEntry } from "../hci/protocol.js";

// ── Settings ──────────────────────────────────────────────────────────────────

export interface LevelSettings {
    srcPort: number;
    dstPort: number;
    label:   string;
    stepDb:  number;
    minDb:   number;
    maxDb:   number;
    [key: string]: JsonValue;
}

// ── In-memory level state  key="src:dst" (0-based) → dB ─────────────────────

const levelState = new Map<string, number>();
const lk = (src: number, dst: number) => `${src}:${dst}`;

// ── Module-level helpers ──────────────────────────────────────────────────────

function snap(db: number, min: number, max: number): number {
    const clamped = Math.max(min, Math.min(max, db));
    return DB_LEVELS.reduce((best, v) =>
        Math.abs(v - clamped) < Math.abs(best - clamped) ? v : best
    );
}

function dbStr(db: number): string {
    return db === 0 ? "0 dB" : `${db > 0 ? "+" : ""}${db} dB`;
}

function levelDb(s: LevelSettings): number {
    if (!s?.srcPort || !s?.dstPort) return 0;
    return levelState.get(lk(s.srcPort - 1, s.dstPort - 1)) ?? 0;
}

async function displayLevel(act: DialAction<LevelSettings>, s: LevelSettings, db: number): Promise<void> {
    const title = s?.label || `${s?.srcPort ?? "?"}→${s?.dstPort ?? "?"}`;
    const min = s?.minDb ?? -72;
    const max = s?.maxDb ?? 18;
    const pct = Math.round(((db - min) / (max - min)) * 100);
    await act.setFeedback({
        title,
        value: dbStr(db),
        indicator: { value: Math.max(0, Math.min(100, pct)), enabled: true },
    }).catch(() => undefined);
}

// ── Action ────────────────────────────────────────────────────────────────────

@action({ UUID: "com.mtcjapan.eclipsehci.level" })
export class LevelAction extends SingletonAction<LevelSettings> {

    override async onWillAppear(ev: WillAppearEvent<LevelSettings>): Promise<void> {
        const s = ev.payload.settings;
        const db = levelDb(s);
        await displayLevel(ev.action as DialAction<LevelSettings>, s, db);
        if (s?.dstPort) hci.requestLevelStatus([s.dstPort - 1]);
    }

    override onWillDisappear(_ev: WillDisappearEvent<LevelSettings>): void {}

    override async onDialRotate(ev: DialRotateEvent<LevelSettings>): Promise<void> {
        const s = ev.payload.settings;
        if (!s?.srcPort || !s?.dstPort) return;
        const src  = s.srcPort - 1;
        const dst  = s.dstPort - 1;
        const key  = lk(src, dst);
        const step = (s.stepDb ?? 1) * ev.payload.ticks;
        const min  = s.minDb ?? -72;
        const max  = s.maxDb ?? 18;
        const newDb = snap((levelState.get(key) ?? 0) + step, min, max);
        hci.send(buildLevelAction(src, dst, newDb));
        levelState.set(key, newDb);
        await displayLevel(ev.action, s, newDb);
    }

    override async onDialDown(ev: DialDownEvent<LevelSettings>): Promise<void> {
        const s = ev.payload.settings;
        if (!s?.srcPort || !s?.dstPort) return;
        const src = s.srcPort - 1, dst = s.dstPort - 1;
        hci.send(buildLevelAction(src, dst, 0));
        levelState.set(lk(src, dst), 0);
        await displayLevel(ev.action, s, 0);
    }

    override async onTouchTap(ev: TouchTapEvent<LevelSettings>): Promise<void> {
        const s = ev.payload.settings;
        if (!s?.srcPort || !s?.dstPort) return;
        const src = s.srcPort - 1, dst = s.dstPort - 1;
        const key = lk(src, dst);
        const cur = levelState.get(key) ?? 0;
        const newDb = cur <= -70 ? 0 : -72;
        hci.send(buildLevelAction(src, dst, newDb));
        levelState.set(key, newDb);
        await displayLevel(ev.action, s, newDb);
    }
}

// ── Called from plugin.ts when matrix reports level status ───────────────────

export function applyLevelStatus(entries: LevelEntry[]): void {
    for (const e of entries) {
        levelState.set(lk(e.srcPort, e.dstPort), e.db);
        for (const act of streamDeck.actions) {
            if (act.manifestId !== "com.mtcjapan.eclipsehci.level") continue;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (act as any).getSettings().then(async (s: LevelSettings) => {
                if ((s.srcPort - 1) === e.srcPort && (s.dstPort - 1) === e.dstPort) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    await displayLevel(act as any as DialAction<LevelSettings>, s, e.db);
                }
            }).catch(() => undefined);
        }
    }
}
