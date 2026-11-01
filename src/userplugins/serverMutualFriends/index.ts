/*
 * Local Equicord/Vencord userplugin.
 * Uses the logged-in client's profile UI data. No tokens or raw HTTP calls.
 * Unofficial: Discord may change these internals or restrict automated access.
 */

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { copyWithToast } from "@utils/discord";
import { sleep } from "@utils/misc";
import definePlugin from "@utils/types";
import { Constants, GuildMemberStore, GuildStore, RestAPI, SelectedGuildStore, UserStore } from "@webpack/common";

type Result = {
    id: string;
    username: string;
    mutualFriends: number | null;
    status: "match" | "none" | "unknown" | "error";
};

let running = false;
let stopRequested = false;
let results: Result[] = [];
let guildName = "";
let scanned = 0;
let total = 0;
let stoppedByRateLimit = false;

const DELAY_MS = 2500;

function csvField(value: string | number | null): string {
    let str = String(value ?? "");
    // Prevent CSV formula execution in spreadsheet software.
    if (/^[\s]*[=+@\-]/.test(str)) str = "'" + str;
    return `"${str.replace(/"/g, '""')}"`;
}

function toCsv() {
    return [
        "username,user_id,mutual_friend_count,status",
        ...[...results]
            .sort((a, b) => (b.mutualFriends ?? -1) - (a.mutualFriends ?? -1))
            .map(r => [r.username, r.id, r.mutualFriends, r.status].map(csvField).join(","))
    ].join("\r\n");
}

async function scan(channelId: string, guildId: string) {
    const currentId = UserStore.getCurrentUser()?.id;
    const guild = GuildStore.getGuild(guildId);
    if (!guild || !currentId) {
        sendBotMessage(channelId, { content: "Open a server channel and try again." });
        return;
    }

    if (running) {
        sendBotMessage(channelId, { content: `A scan is already running (${scanned}/${total}).` });
        return;
    }

    const ids = [...new Set(GuildMemberStore.getMemberIds(guildId))]
        .filter(id => id !== currentId && !UserStore.getUser(id)?.bot);
    if (ids.length === 0) {
        sendBotMessage(channelId, {
            content: "No other server members are cached. Open the member list first. Large servers may only expose a partial member list."
        });
        return;
    }

    running = true;
    stopRequested = false;
    stoppedByRateLimit = false;
    results = [];
    scanned = 0;
    total = ids.length;
    guildName = guild.name;

    sendBotMessage(channelId, {
        content: `Scanning ${ids.length} **currently loaded** members of **${guildName}**, at one profile every ${DELAY_MS / 1000}s. Use /mutualstatus, /mutualstop, or /mutualresults. Nothing is posted publicly.`
    });

    try {
        for (const id of ids) {
            if (stopRequested) break;
            const user = UserStore.getUser(id);
            let status: Result["status"] = "unknown";
            let mutualFriends: number | null = null;
            try {
                // Use the client's own REST wrapper, never a user token or raw fetch.
                // Reading the response avoids stale/missing counts in the profile cache.
                const { body } = await RestAPI.get({
                    url: Constants.Endpoints.USER_PROFILE(id),
                    query: {
                        guild_id: guildId,
                        with_mutual_guilds: false,
                        with_mutual_friends_count: true
                    },
                    oldFormErrors: true
                });
                if (typeof body?.mutual_friends_count === "number") {
                    mutualFriends = body.mutual_friends_count;
                } else if (Array.isArray(body?.mutual_friends)) {
                    mutualFriends = body.mutual_friends.length;
                }
                if (mutualFriends !== null) status = mutualFriends > 0 ? "match" : "none";
            } catch (error) {
                status = "error";
                const err = error as { status?: number; body?: { retry_after?: number } };
                if (err?.status === 429 || err?.body?.retry_after != null) {
                    stoppedByRateLimit = true;
                    stopRequested = true; // Don't hammer Discord after a 429.
                }
            }

            results.push({
                id,
                username: UserStore.getUser(id)?.username ?? user?.username ?? id,
                mutualFriends,
                status
            });
            scanned++;
            if (!stopRequested && scanned < total) await sleep(DELAY_MS);
        }
    } finally {
        running = false;
        const matches = results.filter(x => x.status === "match").length;
        const incomplete = total - scanned;
        const unknown = results.filter(x => x.status === "unknown" || x.status === "error").length;
        sendBotMessage(channelId, {
            content: `${stoppedByRateLimit ? "Stopped due to Discord rate limiting." : stopRequested ? "Scan stopped." : "Scan finished."} Checked ${scanned}/${total} cached members; **${matches} with mutual friends**, ${unknown} unknown/error, ${incomplete} not checked. Use **/mutualresults** to copy the CSV.`
        });
    }
}

export default definePlugin({
    name: "ServerMutualFriends",
    description: "Check mutual-friend counts for the currently cached members of a server.",
    authors: [{ name: "Local", id: 0n }],
    commands: [
        {
            name: "mutualscan",
            description: "Scan members of the current server for mutual friends.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute(_, ctx) {
                const guildId = SelectedGuildStore.getGuildId();
                if (!guildId) {
                    sendBotMessage(ctx.channel.id, { content: "Run this command inside a server." });
                    return;
                }
                void scan(ctx.channel.id, guildId).catch(error => {
                    sendBotMessage(ctx.channel.id, { content: `Scan failed: ${String(error)}` });
                });
            }
        },
        {
            name: "mutualstatus",
            description: "Show mutual-friends scan progress.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute(_, ctx) {
                const matches = results.filter(x => x.status === "match").length;
                sendBotMessage(ctx.channel.id, {
                    content: `${guildName || "No scan yet"}: ${running ? "running" : "idle"}. ${scanned}/${total} checked; ${matches} matches. ${stoppedByRateLimit ? "Stopped by rate limit." : ""}`
                });
            }
        },
        {
            name: "mutualstop",
            description: "Stop the running mutual-friends scan.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute(_, ctx) {
                stopRequested = true;
                sendBotMessage(ctx.channel.id, { content: running ? "Stopping after the current profile finishes." : "No scan is running." });
            }
        },
        {
            name: "mutualresults",
            description: "Copy all checked members and mutual-friend counts as CSV.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute(_, ctx) {
                if (!results.length) {
                    sendBotMessage(ctx.channel.id, { content: "No results yet. Run /mutualscan first." });
                    return;
                }
                copyWithToast(toCsv(), "Mutual-friends CSV copied");
                sendBotMessage(ctx.channel.id, {
                    content: `Copied ${results.length} result rows to clipboard, sorted by mutual-friend count. Paste into a .csv file. ${running ? "This is a partial scan." : ""}`
                });
            }
        }
    ],
    stop() {
        stopRequested = true;
    }
});
