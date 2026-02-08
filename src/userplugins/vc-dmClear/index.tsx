import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

import { addContextMenuPatch, removeContextMenuPatch } from "@api/ContextMenu";
import { openModal, Modals } from "@utils/modal";

import { findByPropsLazy } from "@webpack";
import {
    React,
    Menu,
    Forms,
    Button,
    TextInput,
    TextArea,
    UserStore,
    MessageStore
} from "@webpack/common";

// Discord internal actions (signatures can vary)
const MessageActions = findByPropsLazy("deleteMessage", "fetchMessages");

// Stores
const ChannelStore = findByPropsLazy("getChannel");
const SelectedChannelStore = findByPropsLazy("getChannelId");

// Patch MANY possible menu IDs (DM menus vary a lot between builds)
const MENU_IDS = [
    // Guild channels
    "channel-context",
    "thread-context",

    // Classic DM ids
    "dm-context",
    "gdm-context",

    // Private channel variants (common)
    "private-channel-context",
    "private-channel-user-context",
    "private-channel-recipient-context",
    "private-channel-list-context",

    // Sometimes DM entries are treated like user rows
    "user-context",
    "friends-user-context",
    "friend-row-context"
];

type TargetChannel = { id: string; name?: string; type?: number; };

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function snowflakeToDate(id: string): Date {
    try {
        const discordEpoch = 1420070400000n;
        const ts = (BigInt(id) >> 22n) + discordEpoch;
        return new Date(Number(ts));
    } catch {
        return new Date();
    }
}

function fmt(dt: Date) {
    try {
        return dt.toLocaleString("en-US");
    } catch {
        return dt.toISOString();
    }
}

function safeSnippet(content?: string) {
    const s = (content ?? "").replace(/\s+/g, " ").trim();
    if (!s) return "<empty>";
    return s.length > 140 ? s.slice(0, 140) + "…" : s;
}

function getCachedMessages(channelId: string): any[] {
    const store = MessageStore.getMessages(channelId);
    if (!store) return [];

    try {
        if (typeof store.toArray === "function") return store.toArray();
    } catch { }

    try {
        if (Array.isArray((store as any)._array)) return (store as any)._array;
    } catch { }

    try {
        const msgs = (store as any)._map ?? (store as any)._messages ?? (store as any).messages;
        if (msgs) {
            if (typeof msgs.values === "function") return Array.from(msgs.values());
            if (Array.isArray(msgs)) return msgs;
            if (typeof msgs === "object") return Object.values(msgs);
        }
    } catch { }

    try {
        if (typeof (store as any)[Symbol.iterator] === "function") return Array.from(store as any);
    } catch { }

    return [];
}

async function tryFetchMore(channelId: string, beforeId?: string): Promise<boolean> {
    try {
        const fn = (MessageActions as any)?.fetchMessages;
        if (typeof fn !== "function") return false;

        try {
            await fn({ channelId, limit: 100, before: beforeId });
            return true;
        } catch { }

        try {
            await fn(channelId, beforeId, 100);
            return true;
        } catch { }

        try {
            await fn(channelId, { before: beforeId, limit: 100 });
            return true;
        } catch { }

        return false;
    } catch {
        return false;
    }
}

function getChannelFromContextMenuArgs(args: any[]): TargetChannel | null {
    for (const a of args) {
        if (!a) continue;

        if (a?.channel?.id) return a.channel as TargetChannel;

        if (a?.id && typeof a.id === "string" && !a?.user) return a as TargetChannel;

        const cid = a?.channelId ?? a?.props?.channelId;
        if (cid && typeof cid === "string") {
            try {
                const ch = ChannelStore.getChannel(cid);
                if (ch?.id) return ch;
            } catch { }
        }

        if (a?.props?.channel?.id) return a.props.channel as TargetChannel;
    }

    try {
        const id = SelectedChannelStore.getChannelId?.();
        if (id) {
            const ch = ChannelStore.getChannel(id);
            if (ch?.id) return ch;
        }
    } catch { }

    return null;
}

/**
 * IMPORTANT:
 * We MUST wrap content with Modals.ModalRoot, otherwise Discord treats clicks as "outside" and closes the modal.
 * Additionally we add a "click shield" to stop propagation of mouse events inside the modal.
 */
function DmClearModal(modalProps: any & { channel: TargetChannel; }) {
    const { channel } = modalProps;
    const me = UserStore.getCurrentUser();

    const ModalRoot = (Modals as any)?.ModalRoot;
    const ModalHeader = (Modals as any)?.ModalHeader;
    const ModalContent = (Modals as any)?.ModalContent;
    const ModalFooter = (Modals as any)?.ModalFooter;

    // Safety: if a build lacks these, fail loudly instead of creating a "fake modal"
    if (!ModalRoot || !ModalHeader || !ModalContent || !ModalFooter) {
        return (
            <div style={{ padding: 16 }}>
                <Forms.FormTitle tag="h2">DmClear</Forms.FormTitle>
                <Forms.FormText>
                    Error: Modal components are missing in this build (Modals.ModalRoot/... not found).
                </Forms.FormText>
                <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
                    <Button onClick={modalProps?.onClose}>Close</Button>
                </div>
            </div>
        );
    }

    const [countStr, setCountStr] = React.useState("50");
    const [logs, setLogs] = React.useState<string[]>([]);
    const [running, setRunning] = React.useState(false);

    const pushLog = React.useCallback((line: string) => {
        setLogs(prev => [...prev, `[${fmt(new Date())}] ${line}`]);
    }, []);

    const doDelete = React.useCallback(async () => {
        const requested = Number.parseInt(countStr, 10);
        const limit = Number.isFinite(requested) ? Math.max(1, Math.min(5000, requested)) : 0;

        if (!limit) {
            pushLog("⚠️ Warning: Invalid message count.");
            return;
        }

        setRunning(true);
        pushLog(`▶️ Started | Channel=${channel.name ?? channel.id} | Requested=${limit} | User=${me?.username ?? me?.id}`);

        let deleted = 0;
        const seen = new Set<string>();

        try {
            while (deleted < limit) {
                const cached = getCachedMessages(channel.id);

                if (!cached.length) {
                    pushLog("⚠️ Warning: Cache is empty. Trying to fetch older messages...");
                    const ok = await tryFetchMore(channel.id, undefined);
                    if (!ok) {
                        pushLog("❌ Error: fetchMessages is unavailable/failed. Cannot retrieve older messages.");
                        break;
                    }
                    await sleep(800);
                    continue;
                }

                const sorted = [...cached].sort((a, b) => {
                    const at = a?.timestamp ? new Date(a.timestamp).getTime() : snowflakeToDate(String(a?.id)).getTime();
                    const bt = b?.timestamp ? new Date(b.timestamp).getTime() : snowflakeToDate(String(b?.id)).getTime();
                    return bt - at;
                });

                const mine = sorted.filter(m => m?.author?.id === me?.id && m?.id && !seen.has(String(m.id)));

                if (!mine.length) {
                    const oldest = sorted[sorted.length - 1]?.id ? String(sorted[sorted.length - 1].id) : undefined;
                    pushLog("⚠️ Warning: No more of your messages in cache. Fetching older...");
                    const ok = await tryFetchMore(channel.id, oldest);
                    if (!ok) {
                        pushLog("✅ Done: No more messages could be fetched/found.");
                        break;
                    }
                    await sleep(900);
                    continue;
                }

                for (const msg of mine) {
                    if (deleted >= limit) break;

                    const id = String(msg.id);
                    seen.add(id);

                    const msgTime = msg.timestamp ? new Date(msg.timestamp) : snowflakeToDate(id);
                    const delTime = new Date();

                    try {
                        (MessageActions as any).deleteMessage(channel.id, id);
                        deleted++;

                        pushLog(
                            `🗑️ Deleted (${deleted}/${limit}) | MsgTime=${fmt(msgTime)} | DeletedAt=${fmt(delTime)} | "${safeSnippet(msg.content)}"`
                        );

                        await sleep(1100);
                    } catch (e: any) {
                        pushLog(`❌ Error: deleteMessage failed (id=${id}) -> ${String(e?.message ?? e)}`);
                        await sleep(1500);
                    }
                }
            }

            pushLog(`🏁 Summary: Deleted=${deleted} / Requested=${limit}`);
        } catch (e: any) {
            pushLog(`❌ Fatal error: ${String(e?.message ?? e)}`);
        } finally {
            setRunning(false);
        }
    }, [countStr, pushLog, channel.id, channel.name, me?.id, me?.username]);

    const stop = (e: any) => {
        try { e?.preventDefault?.(); } catch { }
        try { e?.stopPropagation?.(); } catch { }
    };

    const size = (Modals as any)?.ModalSize?.MEDIUM ?? (Modals as any)?.ModalSize?.SMALL;

    return (
        <ModalRoot {...modalProps} size={size}>
            {/* Click shield: prevents "outside click" closing when interacting with inputs/buttons */}
            <div onMouseDown={stop} onClick={stop}>
                <ModalHeader>
                    <Forms.FormTitle tag="h2">DmClear</Forms.FormTitle>
                </ModalHeader>

                <ModalContent>
                    <Forms.FormSection>
                        <Forms.FormTitle tag="h3">How many messages will be deleted?</Forms.FormTitle>
                        <TextInput
                            value={countStr}
                            onChange={(v: string) => setCountStr(v)}
                            placeholder="e.g. 50"
                            disabled={running}
                            autoFocus
                        />
                    </Forms.FormSection>

                    <Forms.FormSection>
                        <Forms.FormTitle tag="h3">Logs</Forms.FormTitle>
                        <TextArea
                            value={logs.join("\n")}
                            readOnly
                            style={{ minHeight: 240 }}
                        />
                    </Forms.FormSection>
                </ModalContent>

                <ModalFooter>
                    <Button onClick={doDelete} disabled={running}>
                        Delete
                    </Button>

                    <Button
                        look={Button.Looks.LINK}
                        color={Button.Colors.PRIMARY}
                        onClick={modalProps?.onClose}
                        disabled={running}
                    >
                        Close
                    </Button>
                </ModalFooter>
            </div>
        </ModalRoot>
    );
}

function openDmClearModal(channel: TargetChannel) {
    // Defer so the context menu close can't interfere
    setTimeout(() => {
        requestAnimationFrame(() => {
            openModal((props: any) => <DmClearModal {...props} channel={channel} />, undefined);
        });
    }, 0);
}

function contextMenuPatch(children: any[], ...args: any[]) {
    const ch = getChannelFromContextMenuArgs(args);
    if (!ch?.id) return;

    children.push(
        <Menu.MenuGroup key="vc-dmclear-group">
            <Menu.MenuItem
                id="vc-dmclear-bulk-delete"
                label="Bulk Delete My Messages"
                action={(e: any) => {
                    try { e?.preventDefault?.(); } catch { }
                    try { e?.stopPropagation?.(); } catch { }
                    openDmClearModal(ch);
                }}
            />
        </Menu.MenuGroup>
    );
}

export default definePlugin({
    name: "DmClear",
    description: "Discord bulk message deleter.",
    authors: [Devs.sikilmem],

    dependencies: ["MenuItemDeobfuscatorAPI"],

    start() {
        for (const id of MENU_IDS) addContextMenuPatch(id, contextMenuPatch);
    },

    stop() {
        for (const id of MENU_IDS) removeContextMenuPatch(id, contextMenuPatch);
    }
});
