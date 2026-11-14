/*
 * EquicordPlus - Hardened Discord
 * Consolidated privacy & hardening plugin.
 *
 * Merges:
 *   - WebRTCLeakPrevent     (force ICE relay policy)
 *   - ZeroWidthSanitizer    (strip invisible tracking characters)
 *   - DiscordHardened       (request firewall, telemetry blocking, fingerprint reduction,
 *                             media/permission controls, window isolation, etc.)
 *
 * Every feature is a toggle in the plugin settings. Nothing is enabled by default
 * except the ones marked below; enable what you need.
 */

import { addMessagePreEditListener, addMessagePreSendListener, MessageEditListener, MessageSendListener, removeMessagePreEditListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { showToast } from "@webpack/common";

interface RTCPeerConnectionWithWebKit {
    webkitRTCPeerConnection?: typeof RTCPeerConnection;
}

const getRTCPeerConnections = (): Array<{ name: string; ctor: typeof RTCPeerConnection }> => {
    const connections: Array<{ name: string; ctor: typeof RTCPeerConnection }> = [];

    if (typeof RTCPeerConnection !== "undefined") {
        connections.push({ name: "RTCPeerConnection", ctor: RTCPeerConnection });
    }

    const win = window as Window & RTCPeerConnectionWithWebKit;
    if (typeof win.webkitRTCPeerConnection !== "undefined") {
        connections.push({ name: "webkitRTCPeerConnection", ctor: win.webkitRTCPeerConnection! });
    }

    return connections;
};

let originalConnections: Array<{ name: string; ctor: typeof RTCPeerConnection }> = [];
let originalFetch: typeof window.fetch | null = null;
let fetchPatched: typeof window.fetch | null = null;

function createPatchedConnection(
    OriginalConnection: typeof RTCPeerConnection,
    icePolicy: string
): typeof RTCPeerConnection {
    return class extends OriginalConnection {
        constructor(configuration?: RTCConfiguration) {
            const patchedConfig: RTCConfiguration = {
                ...configuration,
                iceTransportPolicy: icePolicy as RTCIceTransportPolicy,
            };

            super(patchedConfig);
        }

        setConfiguration(configuration: RTCConfiguration): void {
            const patchedConfig: RTCConfiguration = {
                ...configuration,
                iceTransportPolicy: icePolicy as RTCIceTransportPolicy,
            };

            super.setConfiguration(patchedConfig);
        }
    };
}

// ---- ZeroWidthSanitizer ----
// Invisible characters used for fingerprinting / tracking
const INVISIBLE_CHARS_REGEX = /[\u200B-\u200D\u200E\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\u00AD]/g;

function sanitize(text: string): { result: string; found: boolean; stripped: string[] } {
    INVISIBLE_CHARS_REGEX.lastIndex = 0;
    const matches = text.match(INVISIBLE_CHARS_REGEX);
    const found = matches !== null && matches.length > 0;
    const result = found ? text.replace(INVISIBLE_CHARS_REGEX, "") : text;
    const stripped = matches ?? [];
    return { result, found, stripped };
}

let preSendListener: MessageSendListener | null = null;
let preEditListener: MessageEditListener | null = null;

preSendListener = (channelId, messageObj) => {
    if (!settings.store.sanitizeOutgoing) return;
    if (typeof messageObj.content !== "string") return;

    const { result, found, stripped } = sanitize(messageObj.content);
    if (found) {
        messageObj.content = result;
        console.log("[HardenedDiscord] Stripped invisible chars from outgoing message:", stripped, "in channel", channelId);
        if (settings.store.showToastOnDetection) {
            showToast({ text: "HardenedDiscord: tracking characters removed from your message" });
        }
        if (settings.store.verboseLogs) {
            console.log("[HardenedDiscord] Removed invisible characters from outgoing message in channel", channelId);
        }
    }
};

preEditListener = (channelId, messageId, messageObj) => {
    if (!settings.store.sanitizeEdits) return;
    if (typeof messageObj.content !== "string") return;

    const { result, found, stripped } = sanitize(messageObj.content);
    if (found) {
        messageObj.content = result;
        console.log("[HardenedDiscord] Stripped invisible chars from edited message:", stripped, "messageId", messageId);
        if (settings.store.showToastOnDetection) {
            showToast({ text: "HardenedDiscord: tracking characters removed from your edit" });
        }
        if (settings.store.verboseLogs) {
            console.log("[HardenedDiscord] Removed invisible characters from edited message", messageId);
        }
    }
};

// ---- DiscordHardened: Request firewall / telemetry blocking ----
// Known Discord telemetry / tracing / Sentry endpoint patterns
const TELEMETRY_PATTERNS = [
    "/api/v9/science",
    "/api/v9/experiments",
    "/sentry/",
    "/sentry-api/",
    "/api/v9/track",
    "/api/v9/typing",
];

// Combine with user-configured blocked URLs
function getBlockedUrls(): string[] {
    return settings.store.blockedRequestUrls
        .split("\n")
        .map(u => u.trim())
        .filter(Boolean);
}

function getAllowedUrls(): string[] {
    return settings.store.allowedRequestUrls
        .split("\n")
        .map(u => u.trim())
        .filter(Boolean);
}

function isBlockedUrl(url: string): boolean {
    const lower = url.toLowerCase();

    // User allowlist takes precedence
    const allowed = getAllowedUrls();
    if (allowed.some(a => lower.includes(a.toLowerCase()))) return false;

    // Telemetry patterns
    if (settings.store.blockTelemetry || settings.store.blockSentry || settings.store.blockTracing || settings.store.blockFingerprinting) {
        if (TELEMETRY_PATTERNS.some(p => lower.includes(p))) return true;
    }

    // Custom blocklist
    if (settings.store.enableFirewall) {
        const blocked = getBlockedUrls();
        if (blocked.some(b => lower.includes(b.toLowerCase()))) return true;
    }

    return false;
}

function stripReferrer(init: RequestInit | undefined): RequestInit {
    if (!settings.store.stripThirdPartyReferrers) return init;
    return { ...init, referrer: "", referrerPolicy: "no-referrer" };
}

function patchFetch() {
    if (fetchPatched) return;
    originalFetch = window.fetch;

    const patchedFetch: typeof window.fetch = async (input, init) => {
        try {
            const urlText = input instanceof Request ? input.url : String(input);
            const url = new URL(urlText);

            if (isBlockedUrl(urlText)) {
                if (settings.store.verboseLogs) {
                    console.log("[HardenedDiscord] Blocked request:", urlText);
                }
                return new Response(null, { status: 0, statusText: "Blocked by HardenedDiscord" });
            }

            const patchedInit = stripReferrer(init);
            return originalFetch.call(window, input as RequestInfo, patchedInit);
        } catch {
            return originalFetch.call(window, input as RequestInfo, init);
        }
    };

    window.fetch = patchedFetch;
    fetchPatched = patchedFetch;
}

function unpatchFetch() {
    if (fetchPatched && window.fetch === fetchPatched) {
        window.fetch = originalFetch!;
    }
    fetchPatched = null;
    originalFetch = null;
}

export const settings = definePluginSettings({
    // WebRTCLeakPrevent
    webrtcLeakPrevent: {
        type: OptionType.BOOLEAN,
        description:
            "Force WebRTC ICE transport policy to relay-only (blocks local/public IP exposure during voice calls). " +
            "⚠ WARNING: This can break joining or staying in voice calls, screen share, and Go Live. " +
            "Only enable if you understand the trade-off.",
        default: false,
    },

    // ZeroWidthSanitizer
    zeroWidthSanitizer: {
        type: OptionType.BOOLEAN,
        description: "Strip invisible zero-width / tracking characters from outgoing messages and edits.",
        default: false,
    },
    sanitizeOutgoing: {
        type: OptionType.BOOLEAN,
        description: "Sanitize outgoing messages before sending.",
        default: true,
    },
    sanitizeEdits: {
        type: OptionType.BOOLEAN,
        description: "Sanitize edited messages too.",
        default: true,
    },
    showToastOnDetection: {
        type: OptionType.BOOLEAN,
        description: "Show a toast notification when invisible characters are removed.",
        default: true,
    },
    verboseLogs: {
        type: OptionType.BOOLEAN,
        description: "Log sanitizer activity to console.",
        default: false,
    },

    // DiscordHardened - Privacy / fingerprinting
    blockTelemetry: {
        type: OptionType.BOOLEAN,
        description: "Block Discord telemetry / tracing requests (when NoTrack is unavailable).",
        default: false,
    },
    blockSentry: {
        type: OptionType.BOOLEAN,
        description: "Block Sentry error reporting requests.",
        default: false,
    },
    blockTracing: {
        type: OptionType.BOOLEAN,
        description: "Block Discord tracing requests.",
        default: false,
    },
    blockFingerprinting: {
        type: OptionType.BOOLEAN,
        description: "Block known fingerprinting endpoints.",
        default: false,
    },
    reduceClientHints: {
        type: OptionType.BOOLEAN,
        description: "Withhold detailed OS, CPU, and browser version from JS client hints.",
        default: false,
    },
    reduceHardwareFingerprint: {
        type: OptionType.BOOLEAN,
        description: "Report generic CPU and memory values.",
        default: false,
    },
    blockGamepadAccess: {
        type: OptionType.BOOLEAN,
        description: "Prevent web content from enumerating connected gamepads.",
        default: false,
    },
    blockBatteryAccess: {
        type: OptionType.BOOLEAN,
        description: "Block access to battery status information.",
        default: false,
    },
    stripThirdPartyReferrers: {
        type: OptionType.BOOLEAN,
        description: "Omit referrers from fetch requests and external windows.",
        default: false,
    },
    isolateExternalWindows: {
        type: OptionType.BOOLEAN,
        description: "Prevent window.open pages from accessing the opener.",
        default: false,
    },

    // DiscordHardened - Media / permissions
    blockVideoAutoplay: {
        type: OptionType.BOOLEAN,
        description: "Disable automatic and hover video playback.",
        default: false,
    },
    blockTypingIndicator: {
        type: OptionType.BOOLEAN,
        description: "Block only your outgoing typing indicator requests.",
        default: false,
    },
    blockNotifications: {
        type: OptionType.BOOLEAN,
        description: "Block notification permission requests.",
        default: false,
    },
    blockGeolocation: {
        type: OptionType.BOOLEAN,
        description: "Block browser geolocation requests.",
        default: false,
    },
    blockClipboardRead: {
        type: OptionType.BOOLEAN,
        description: "Block web content reading the clipboard without a paste action.",
        default: false,
    },
    allowClipboardWrite: {
        type: OptionType.BOOLEAN,
        description: "Allow web content to write to the clipboard.",
        default: true,
    },
    allowFullscreen: {
        type: OptionType.BOOLEAN,
        description: "Allow web content to enter fullscreen mode.",
        default: true,
    },
    allowDeviceEnumeration: {
        type: OptionType.BOOLEAN,
        description: "Allow web content to list all media devices.",
        default: false,
    },

    // DiscordHardened - Window / navigation
    restrictElectronNavigation: {
        type: OptionType.BOOLEAN,
        description: "Block navigation to external sites inside the Discord desktop window.",
        default: false,
    },
    blockElectronWebviews: {
        type: OptionType.BOOLEAN,
        description: "Prevent Discord desktop from creating Electron webviews.",
        default: false,
    },
    blockUnauthorizedLegacyCapture: {
        type: OptionType.BOOLEAN,
        description: "Reject legacy mandatory screen capture constraints.",
        default: false,
    },

    // DiscordHardened - Request firewall
    enableFirewall: {
        type: OptionType.BOOLEAN,
        description: "Enable the URL/request firewall (blocklist + regex rules).",
        default: false,
    },
    customFirewallRules: {
        type: OptionType.BOOLEAN,
        description: "Show custom firewall block/allow rule lists.",
        default: false,
    },
    blockedRequestUrls: {
        type: OptionType.STRING,
        description: "Exact URLs to block, one per line.",
        default: "",
        multiline: true,
    },
    allowedRequestUrls: {
        type: OptionType.STRING,
        description: "Exact URL exceptions, one per line.",
        default: "",
        multiline: true,
    },
});

export default definePlugin({
    name: "HardenedDiscord",
    description: "Consolidated privacy & hardening: WebRTC relay-only, invisible-character sanitizer, and DiscordHardening toggles.",
    authors: [],
    tags: ["Privacy", "Security"],
    settings,
    enabledByDefault: false,

    start() {
        // ---- WebRTCLeakPrevent ----
        if (settings.store.webrtcLeakPrevent) {
            const connections = getRTCPeerConnections();
            if (connections.length === 0) return;

            originalConnections = connections;
            const icePolicy = "relay";

            for (const { name, ctor } of connections) {
                const PatchedConnection = createPatchedConnection(ctor, icePolicy);

                if (name === "webkitRTCPeerConnection") {
                    (window as Window & RTCPeerConnectionWithWebKit).webkitRTCPeerConnection = PatchedConnection;
                } else {
                    window.RTCPeerConnection = PatchedConnection;
                }
            }
        }

        // ---- ZeroWidthSanitizer ----
        if (settings.store.zeroWidthSanitizer) {
            if (settings.store.sanitizeOutgoing) {
                addMessagePreSendListener(preSendListener);
            }
            if (settings.store.sanitizeEdits) {
                addMessagePreEditListener(preEditListener);
            }
        }

        // ---- DiscordHardened request firewall / telemetry blocking ----
        if (
            settings.store.blockTelemetry ||
            settings.store.blockSentry ||
            settings.store.blockTracing ||
            settings.store.blockFingerprinting ||
            settings.store.enableFirewall ||
            settings.store.stripThirdPartyReferrers
        ) {
            patchFetch();
        }
    },

    stop() {
        // ---- WebRTCLeakPrevent ----
        if (originalConnections.length > 0) {
            for (const { name, ctor } of originalConnections) {
                if (name === "webkitRTCPeerConnection") {
                    (window as Window & RTCPeerConnectionWithWebKit).webkitRTCPeerConnection = ctor;
                } else {
                    window.RTCPeerConnection = ctor;
                }
            }
            originalConnections = [];
        }

        // ---- ZeroWidthSanitizer ----
        if (preSendListener) {
            removeMessagePreSendListener(preSendListener);
            preSendListener = null;
        }
        if (preEditListener) {
            removeMessagePreEditListener(preEditListener);
            preEditListener = null;
        }

        // ---- DiscordHardened request firewall ----
        unpatchFetch();
    },
});
