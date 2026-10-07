/*
 * EquicordPlus, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { DataStore } from "@api/index";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { Constants, FluxDispatcher, React, RestAPI, UserStore } from "@webpack/common";

const TokenStore = findByPropsLazy("getToken", "setToken", "encryptAndStoreTokens", "removeToken") as any;
const MultiAccountStore = findByPropsLazy("getUsers", "getValidUsers", "getIsValidatingUsers") as any;

const LEGACY_STORE_KEY = "tokenLoginManager.data";

interface DiscordUser {
    id: string;
    username: string;
    discriminator?: string;
    avatar?: string | null;
    global_name?: string | null;
}

interface LegacyAccount {
    id: string;
    token: string;
    username: string;
}

type ValidationResult =
    | { status: "valid"; user: DiscordUser; }
    | { status: "invalid" | "rate_limited" | "error"; };

function normalizeToken(value: string) {
    return value.trim().replace(/^["']|["']$/g, "");
}

function extractTokens(raw: string) {
    const tokens = new Set<string>();

    // Match the long-standing Discord token formats first so pasted text can
    // contain labels or other content without treating every word as a token.
    const matches = raw.match(/(?:mfa\.[\w-]{20,}|[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,})/g);
    matches?.forEach(token => tokens.add(normalizeToken(token)));

    // Also accept one-token-per-line input so future token formats still work.
    for (const line of raw.split(/\r?\n/)) {
        const token = normalizeToken(line);
        if (token.length >= 20 && !/\s/.test(token)) tokens.add(token);
    }

    return [...tokens];
}

async function validateToken(token: string): Promise<ValidationResult> {
    try {
        const response = await RestAPI.get({
            url: Constants.Endpoints.ME,
            headers: { authorization: token },
            retries: 0,
            rejectWithError: false
        } as any) as any;

        if (response?.status === 200 && response.body?.id) {
            return { status: "valid", user: response.body as DiscordUser };
        }

        if (response?.status === 401 || response?.status === 403) return { status: "invalid" };
        if (response?.status === 429) return { status: "rate_limited" };
        return { status: "error" };
    } catch (error: any) {
        if (error?.status === 401 || error?.status === 403) return { status: "invalid" };
        if (error?.status === 429) return { status: "rate_limited" };
        return { status: "error" };
    }
}

function getNativeUsers(): any[] {
    return MultiAccountStore?.getUsers?.() ?? MultiAccountStore?.getState?.()?.users ?? [];
}

function storePerUserToken(token: string, userId: string) {
    const currentUserId = UserStore.getCurrentUser()?.id;
    const currentToken = TokenStore.getToken?.();

    // Discord's setToken(token, userId) also updates the current in-memory
    // token. Restore the current account synchronously before yielding.
    TokenStore.setToken(token, userId);

    if (currentToken) {
        TokenStore.setToken(currentToken, currentUserId);
    }

    TokenStore.encryptAndStoreTokens?.();
}

function upsertNativeAccount(token: string, user: DiscordUser) {
    const users = getNativeUsers();
    let account = users.find(entry => entry.id === user.id);
    const existed = Boolean(account);

    if (!account) {
        account = {
            id: user.id,
            avatar: user.avatar ?? null,
            username: user.username,
            discriminator: user.discriminator ?? "0",
            tokenStatus: 2,
            pushSyncToken: null
        };
        users.push(account);
    } else {
        account.avatar = user.avatar ?? account.avatar ?? null;
        account.username = user.username ?? account.username;
        account.discriminator = user.discriminator ?? account.discriminator ?? "0";
        account.tokenStatus = 2;
    }

    storePerUserToken(token, user.id);

    // Ensure the user object exists in UserStore for the native account row.
    FluxDispatcher.dispatch({ type: "USER_UPDATE", user });

    // MultiAccountStore clones/persists its user list in this handler. Because
    // getUsers() returns the backing array, the inserted row is included.
    FluxDispatcher.dispatch({
        type: "MULTI_ACCOUNT_VALIDATE_TOKEN_SUCCESS",
        userId: user.id
    });

    return existed;
}

async function importToken(token: string) {
    const result = await validateToken(token);
    if (result.status !== "valid") return result;

    const existed = upsertNativeAccount(token, result.user);
    return { ...result, existed };
}

function copyText(value: string) {
    const nativeCopy = (window as any).DiscordNative?.clipboard?.copy;
    if (typeof nativeCopy === "function") {
        nativeCopy(value);
        return Promise.resolve();
    }

    return navigator.clipboard.writeText(value);
}

async function getLegacyAccounts(): Promise<Record<string, LegacyAccount>> {
    try {
        return await DataStore.get<Record<string, LegacyAccount>>(LEGACY_STORE_KEY) ?? {};
    } catch {
        return {};
    }
}

function TokenTools() {
    const [rawTokens, setRawTokens] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [summary, setSummary] = React.useState("");
    const [legacyCount, setLegacyCount] = React.useState(0);

    const detectedTokens = React.useMemo(() => extractTokens(rawTokens), [rawTokens]);

    React.useEffect(() => {
        let cancelled = false;
        void getLegacyAccounts().then(accounts => {
            if (!cancelled) setLegacyCount(Object.keys(accounts).length);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    async function importTokens(tokens: string[], clearInput = false) {
        if (busy || tokens.length === 0) return;

        setBusy(true);
        let added = 0;
        let refreshed = 0;
        let invalid = 0;
        let rateLimited = 0;
        let errors = 0;

        try {
            const seenUserIds = new Set<string>();

            for (let index = 0; index < tokens.length; index++) {
                const token = normalizeToken(tokens[index]);
                setSummary(`Checking ${index + 1}/${tokens.length}…`);

                const result = await importToken(token);
                if (result.status === "valid") {
                    if (seenUserIds.has(result.user.id) || result.existed) refreshed++;
                    else added++;
                    seenUserIds.add(result.user.id);
                } else if (result.status === "invalid") {
                    invalid++;
                } else if (result.status === "rate_limited") {
                    rateLimited++;
                } else {
                    errors++;
                }

                if (index + 1 < tokens.length) {
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }

            const parts = [
                added ? `${added} added` : "",
                refreshed ? `${refreshed} refreshed` : "",
                invalid ? `${invalid} invalid` : "",
                rateLimited ? `${rateLimited} rate-limited` : "",
                errors ? `${errors} errors` : ""
            ].filter(Boolean);

            setSummary(parts.join(" • ") || "Nothing changed");
            if (clearInput && added + refreshed > 0) setRawTokens("");
        } finally {
            setBusy(false);
        }
    }

    async function verifyAll(removeInvalid: boolean) {
        if (busy) return;
        setBusy(true);

        const accounts = [...getNativeUsers()];
        let valid = 0;
        let invalid = 0;
        let skipped = 0;

        try {
            for (let index = 0; index < accounts.length; index++) {
                const account = accounts[index];
                setSummary(`Verifying ${index + 1}/${accounts.length}…`);

                const token = TokenStore.getToken?.(account.id);
                if (!token) {
                    invalid++;
                    FluxDispatcher.dispatch({ type: "MULTI_ACCOUNT_VALIDATE_TOKEN_FAILURE", userId: account.id });
                    if (removeInvalid) {
                        FluxDispatcher.dispatch({ type: "MULTI_ACCOUNT_REMOVE_ACCOUNT", userId: account.id });
                    }
                    continue;
                }

                const result = await validateToken(token);
                if (result.status === "valid" && result.user.id === account.id) {
                    valid++;
                    account.avatar = result.user.avatar ?? account.avatar ?? null;
                    account.username = result.user.username ?? account.username;
                    account.discriminator = result.user.discriminator ?? account.discriminator ?? "0";
                    FluxDispatcher.dispatch({ type: "USER_UPDATE", user: result.user });
                    FluxDispatcher.dispatch({ type: "MULTI_ACCOUNT_VALIDATE_TOKEN_SUCCESS", userId: account.id });
                } else if (result.status === "invalid" || (result.status === "valid" && result.user.id !== account.id)) {
                    invalid++;
                    FluxDispatcher.dispatch({ type: "MULTI_ACCOUNT_VALIDATE_TOKEN_FAILURE", userId: account.id });
                    if (removeInvalid) {
                        FluxDispatcher.dispatch({ type: "MULTI_ACCOUNT_REMOVE_ACCOUNT", userId: account.id });
                    }
                } else {
                    skipped++;
                }

                if (index + 1 < accounts.length) {
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }

            setSummary(
                `${valid} valid • ${invalid} invalid` +
                (skipped ? ` • ${skipped} not removed (network/rate limit)` : "") +
                (removeInvalid && invalid ? ` • ${invalid} removed` : "")
            );
        } finally {
            setBusy(false);
        }
    }

    async function migrateLegacy() {
        if (busy) return;

        const legacy = await getLegacyAccounts();
        const entries = Object.entries(legacy);
        if (!entries.length) {
            setLegacyCount(0);
            return;
        }

        setBusy(true);
        const remaining: Record<string, LegacyAccount> = {};
        let migrated = 0;
        let failed = 0;

        try {
            for (let index = 0; index < entries.length; index++) {
                const [key, account] = entries[index];
                setSummary(`Migrating legacy account ${index + 1}/${entries.length}…`);

                const result = await importToken(normalizeToken(account.token));
                if (result.status === "valid") migrated++;
                else {
                    remaining[key] = account;
                    failed++;
                }

                if (index + 1 < entries.length) {
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }

            await DataStore.set(LEGACY_STORE_KEY, remaining);
            setLegacyCount(Object.keys(remaining).length);
            setSummary(`${migrated} legacy account${migrated === 1 ? "" : "s"} migrated` + (failed ? ` • ${failed} kept for retry` : ""));
        } finally {
            setBusy(false);
        }
    }

    async function copyCurrentToken() {
        const token = TokenStore.getToken?.();
        if (!token) {
            setSummary("Current token is unavailable.");
            return;
        }

        try {
            await copyText(token);
            setSummary("Current token copied.");
        } catch {
            setSummary("Could not copy the current token.");
        }
    }

    return (
        <div className="ecp-token-tools">
            <div className="ecp-token-tools-header">
                <div>
                    <div className="ecp-token-tools-title">Token accounts</div>
                    <div className="ecp-token-tools-subtitle">
                        Validate tokens and add them directly to Discord&apos;s native account switcher.
                    </div>
                </div>
                <button
                    className="ecp-token-button ecp-token-button-secondary"
                    disabled={busy}
                    onClick={() => void copyCurrentToken()}
                >
                    Copy current token
                </button>
            </div>

            <textarea
                className="ecp-token-input"
                value={rawTokens}
                onChange={event => setRawTokens(event.target.value)}
                placeholder="Paste one or more Discord tokens (one per line)"
                spellCheck={false}
                rows={3}
            />

            <div className="ecp-token-actions">
                <button
                    className="ecp-token-button ecp-token-button-primary"
                    disabled={busy || detectedTokens.length === 0}
                    onClick={() => void importTokens(detectedTokens, true)}
                >
                    {busy ? "Working…" : `Verify & add${detectedTokens.length ? ` (${detectedTokens.length})` : ""}`}
                </button>
                <button
                    className="ecp-token-button ecp-token-button-secondary"
                    disabled={busy || getNativeUsers().length === 0}
                    onClick={() => void verifyAll(false)}
                >
                    Verify all
                </button>
                <button
                    className="ecp-token-button ecp-token-button-danger"
                    disabled={busy || getNativeUsers().length === 0}
                    onClick={() => void verifyAll(true)}
                >
                    Remove invalid
                </button>
                {legacyCount > 0 && (
                    <button
                        className="ecp-token-button ecp-token-button-secondary"
                        disabled={busy}
                        onClick={() => void migrateLegacy()}
                    >
                        Migrate legacy ({legacyCount})
                    </button>
                )}
            </div>

            {summary && <div className="ecp-token-summary">{summary}</div>}
        </div>
    );
}

export default definePlugin({
    name: "TokenLoginManager",
    description: "Integrates token import, validation and cleanup into Discord's native Switch Accounts / Manage Accounts UI.",
    authors: [{ name: "Chaython", id: 1415804298771824740n }],
    dependencies: ["UnlimitedAccounts"],

    patches: [
        {
            find: "getCurrentUser(),multiAccountUsers",
            replacement: {
                match: /children:\[(\i),\(0,(\i)\.jsx\)\((\i)\.A,\{actionText:/,
                replace: "children:[$1,(0,$2.jsx)($self.TokenTools,{}),(0,$2.jsx)($3.A,{actionText:"
            }
        }
    ],

    TokenTools,

    start() {
        // Force lazy modules to resolve while the plugin is active. No global
        // token-sniffing hooks are installed; Discord's own token store is used.
        void TokenStore;
        void MultiAccountStore;
    }
});
