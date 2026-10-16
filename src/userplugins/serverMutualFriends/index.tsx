/*
 * EquicordPlus — Server Mutual Friends
 * Copyright (c) 2026 Chaython
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Unofficial client helper. No account token extraction or third-party uploads.
 */

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { copyWithToast } from "@utils/discord";
import { sleep } from "@utils/misc";
import definePlugin from "@utils/types";
import { Constants, GuildMemberStore, GuildStore, RestAPI, SelectedGuildStore, UserStore } from "@webpack/common";

type Status = "match" | "none" | "unknown" | "error";
type Result = { id: string; username: string; mutualFriends: number | null; status: Status; };

const DELAY_MS = 2500;
let running = false;
let stopRequested = false;
let stoppedByRateLimit = false;
let guildName = "";
let total = 0;
let scanned = 0;
let results: Result[] = [];

function PluginInfo() {
    return (
        <div style={{ lineHeight: 1.5 }}>
            <p><strong>Server Mutual Friends</strong> by Chaython — an unofficial, client-side EquicordPlus utility.</p>
            <p>Open a channel in the target server, let the member list load, then use <code>/mutualscan</code>. Check <code>/mutualstatus</code>, cancel with <code>/mutualstop</code>, and copy the CSV with <code>/mutualresults</code>.</p>
            <ul style={{ paddingLeft: 20 }}>
                <li><strong>Coverage:</strong> only members already cached by Discord. Large servers may not be fully scanned.</li>
                <li><strong>Rate limiting:</strong> one profile request every 2.5 seconds; the scan stops if Discord returns HTTP 429. Avoid repeated bulk scans.</li>
                <li><strong>Accuracy:</strong> missing or failed mutual-friend counts are unknown/error, never assumed to be zero.</li>
                <li><strong>Privacy:</strong> results stay in memory until reload or another scan. CSV is copied locally; nothing is messaged to other members or sent to third parties.</li>
                <li><strong>Compatibility:</strong> relies on unofficial Discord client internals and may break or violate Discord automation rules.</li>
            </ul>
            <p>The exported CSV contains all checked members (including zero and unknown counts). This feature has not been live-tested.</p>
        </div>
    );
}

function csvField(value: string | number | null): string {
    let text = String(value ?? "");
    // Prevent spreadsheet formulas from running when the CSV is opened.
    if (/^\s*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
}

function toCsv(): string {
    const rows = [...results].sort((a, b) => (b.mutualFriends ?? -1) - (a.mutualFriends ?? -1));
    return [
        "username,user_id,mutual_friend_count,status",
        ...rows.map(r => [r.username, r.id, r.mutualFriends, r.status].map(csvField).join(","))
    ].join("\r\n");
}

function matchCount(): number {
    return results.filter(r => r.status === "match").length;
}

async function scan(channelId: string, guildId: string): Promise<void> {
    if (running) {
        sendBotMessage(channelId, { content: "Already scanning (" + scanned + "/" + total + ")." });
        return;
    }

    const guild = GuildStore.getGuild(guildId);
    const currentId = UserStore.getCurrentUser()?.id;
    if (!guild || !currentId) {
        sendBotMessage(channelId, { content: "Open a server channel and try again." });
        return;
    }

    const ids = [...new Set(GuildMemberStore.getMemberIds(guildId))]
        .filter(id => id !== currentId && !UserStore.getUser(id)?.bot);
    if (!ids.length) {
        sendBotMessage(channelId, { content: "No other members are cached. Open the member list first; large servers can be incomplete." });
        return;
    }

    running = true;
    stopRequested = false;
    stoppedByRateLimit = false;
    guildName = guild.name;
    total = ids.length;
    scanned = 0;
    results = [];

    sendBotMessage(channelId, {
        content: "Checking " + total + " **cached** members of **" + guildName + "** (one request every 2.5s). Use /mutualstatus, /mutualstop and /mutualresults. This is a local-only scan."
    });

    try {
        for (const id of ids) {
            if (stopRequested) break;
            let status: Status = "unknown";
            let mutualFriends: number | null = null;
            try {
                // A client profile request, not a raw fetch or account-token request.
                const response = await RestAPI.get({
                    url: Constants.Endpoints.USER_PROFILE(id),
                    query: {
                        guild_id: guildId,
                        with_mutual_guilds: false,
                        with_mutual_friends_count: true
                    },
                    oldFormErrors: true
                });
                const body = response.body;
                if (Number.isSafeInteger(body?.mutual_friends_count) && body.mutual_friends_count >= 0) {
                    mutualFriends = body.mutual_friends_count;
                } else if (Array.isArray(body?.mutual_friends)) {
                    mutualFriends = body.mutual_friends.length;
                }
                if (mutualFriends !== null) status = mutualFriends > 0 ? "match" : "none";
            } catch (error) {
                status = "error";
                const err = error as { status?: number; body?: { retry_after?: number }; };
                if (err?.status === 429 || err?.body?.retry_after != null) {
                    stoppedByRateLimit = true;
                    stopRequested = true;
                }
            }

            results.push({
                id,
                username: UserStore.getUser(id)?.username ?? id,
                mutualFriends,
                status
            });
            scanned++;
            if (!stopRequested && scanned < total) await sleep(DELAY_MS);
        }
    } finally {
        running = false;
        const unknown = results.filter(r => r.status === "unknown" || r.status === "error").length;
        const result = stoppedByRateLimit ? "Stopped after Discord rate limiting." : stopRequested ? "Scan cancelled." : "Scan complete.";
        sendBotMessage(channelId, {
            content: result + " Checked " + scanned + "/" + total + " cached members; **" + matchCount() + " matches**, " + unknown + " unknown/error, " + (total - scanned) + " not checked. /mutualresults copies CSV."
        });
    }
}

export default definePlugin({
    name: "ServerMutualFriends",
    description: "Find mutual friends among cached server members; scan status, stop and CSV export. Unofficial; large servers may be incomplete.",
    authors: [{ name: "Chaython", id: 0n, badge: false }],
    dependencies: ["CommandsAPI"],
    settingsAboutComponent: PluginInfo,
    commands: [
        {
            name: "mutualscan",
            description: "Scan cached server members for mutual friends.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute(_, ctx) {
                const guildId = SelectedGuildStore.getGuildId();
                if (!guildId) {
                    sendBotMessage(ctx.channel.id, { content: "Run this in a server channel." });
                    return;
                }
                void scan(ctx.channel.id, guildId).catch(error =>
                    sendBotMessage(ctx.channel.id, { content: "Scan failed: " + String(error) })
                );
            }
        },
        {
            name: "mutualstatus",
            description: "Show the mutual-friends scan's progress.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute(_, ctx) {
                sendBotMessage(ctx.channel.id, {
                    content: (guildName || "No scan yet") + ": " + (running ? "running" : "idle") + ". " + scanned + "/" + total + " checked; " + matchCount() + " matches." + (stoppedByRateLimit ? " Stopped by rate limit." : "")
                });
            }
        },
        {
            name: "mutualstop",
            description: "Cancel the current mutual-friends scan.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute(_, ctx) {
                if (running) stopRequested = true;
                sendBotMessage(ctx.channel.id, {
                    content: running ? "Stopping after the current request." : "No scan is running."
                });
            }
        },
        {
            name: "mutualresults",
            description: "Copy checked members and mutual-friend counts as CSV.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            async execute(_, ctx) {
                if (!results.length) {
                    sendBotMessage(ctx.channel.id, { content: "No results yet. Use /mutualscan first." });
                    return;
                }
                try {
                    await copyWithToast(toCsv(), "Mutual-friends CSV copied");
                    sendBotMessage(ctx.channel.id, {
                        content: "Copied " + results.length + " result rows, sorted by mutual-friend count." + (running ? " Scan still running; results are partial." : "")
                    });
                } catch {
                    sendBotMessage(ctx.channel.id, { content: "Clipboard copy failed. Check browser clipboard permissions." });
                }
            }
        }
    ],
    stop() {
        stopRequested = true;
    }
});
