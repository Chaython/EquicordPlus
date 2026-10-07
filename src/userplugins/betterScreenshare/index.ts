/*
 * EquicordPlus user plugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";

interface MethodPatch {
    target: any;
    key: string;
    hadOwn: boolean;
    descriptor?: PropertyDescriptor;
    replacement: Function;
}

const patches: MethodPatch[] = [];
const screenTracks = new WeakSet<MediaStreamTrack>();
const trackedSenders = new Set<RTCRtpSender>();
const previousOutboundStats = new WeakMap<RTCRtpSender, { bytesSent: number; timestamp: number; }>();
let overlay: HTMLDivElement | null = null;
let overlayTimer: number | null = null;

const MAX_BITRATE = 20_000_000;
const MAX_FRAMERATE = 60;
const CONTENT_HINT = "detail";

const settings = definePluginSettings({
    improveCapture: {
        type: OptionType.BOOLEAN,
        description: "Prefer detailed screen capture without overriding Discord's selected resolution or aspect ratio",
        default: true
    },
    tuneSender: {
        type: OptionType.BOOLEAN,
        description: "Raise WebRTC bitrate/FPS ceilings without overriding Discord's scaling or resolution decisions",
        default: true
    },
    preferModernCodecs: {
        type: OptionType.BOOLEAN,
        description: "Prefer VP9, then AV1, H.264 and VP8 when Discord/Chromium exposes codec preferences",
        default: true
    },
    diagnosticsOverlay: {
        type: OptionType.BOOLEAN,
        description: "Show a live screen-share diagnostics overlay",
        default: false,
        onChange(value) {
            if (value) startOverlay();
            else stopOverlay();
        }
    },
    verboseLogging: {
        type: OptionType.BOOLEAN,
        description: "Log screen-share capture/sender tuning details to the console",
        default: false
    }
});

function patchMethod(target: any, key: string, createReplacement: (original: Function) => Function) {
    const original = target?.[key];
    if (typeof original !== "function") return;

    const hadOwn = Object.prototype.hasOwnProperty.call(target, key);
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    const replacement = createReplacement(original);

    try {
        Object.defineProperty(target, key, {
            configurable: true,
            writable: true,
            value: replacement
        });
        patches.push({ target, key, hadOwn, descriptor, replacement });
    } catch (error) {
        console.warn(`[BetterScreenshare] Could not patch ${key}:`, error);
    }
}

function restorePatches() {
    for (const patch of patches.splice(0).reverse()) {
        if (patch.target?.[patch.key] !== patch.replacement) continue;

        try {
            if (patch.hadOwn && patch.descriptor) {
                Object.defineProperty(patch.target, patch.key, patch.descriptor);
            } else {
                delete patch.target[patch.key];
            }
        } catch (error) {
            console.warn(`[BetterScreenshare] Could not restore ${patch.key}:`, error);
        }
    }
}

function markScreenTrack(track: MediaStreamTrack) {
    if (track.kind !== "video") return;
    screenTracks.add(track);
    try {
        if (settings.store.improveCapture) track.contentHint = CONTENT_HINT;
    } catch {}

    track.addEventListener("ended", () => {
        for (const sender of [...trackedSenders]) {
            if (sender.track === track) trackedSenders.delete(sender);
        }
    }, { once: true });
}

function improveDisplayConstraints(constraints: DisplayMediaStreamOptions = {}): DisplayMediaStreamOptions {
    // Do not replace Discord's capture dimensions, aspect ratio, resizeMode,
    // or explicit frame-rate choice. Rewriting capture constraints can make
    // Chromium renegotiate between Discord's layer geometry and ours, which
    // presents as stretched frames or rapid native/stretched flicker.
    if (!settings.store.improveCapture) return constraints;

    const originalVideo = constraints.video;
    if (originalVideo === false || !originalVideo || typeof originalVideo !== "object") {
        return constraints;
    }

    return {
        ...constraints,
        video: { ...originalVideo }
    };
}

function orderedVideoCodecs() {
    if (!settings.store.preferModernCodecs || typeof RTCRtpSender.getCapabilities !== "function") return [];
    const codecs = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
    const order = ["video/VP9", "video/AV1", "video/H264", "video/VP8"];

    return [...codecs].sort((a, b) => {
        const ai = order.indexOf(a.mimeType);
        const bi = order.indexOf(b.mimeType);
        return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi);
    });
}

async function tuneSender(sender: RTCRtpSender) {
    const track = sender.track;
    if (!track || track.kind !== "video" || !screenTracks.has(track)) return;

    trackedSenders.add(sender);
    if (!settings.store.tuneSender) return;

    try {
        const parameters = sender.getParameters();
        const encodings = parameters.encodings;

        // Never manufacture an encoding or rewrite scaleResolutionDownBy.
        // Discord uses its encoding layers to preserve source geometry and to
        // move between quality levels. Forcing a layer to scale=1 can make the
        // encoder alternate between incompatible dimensions.
        if (!encodings?.length) return;

        for (const encoding of encodings) {
            encoding.maxBitrate = Math.max(encoding.maxBitrate ?? 0, MAX_BITRATE);
            encoding.maxFramerate = Math.max(encoding.maxFramerate ?? 0, MAX_FRAMERATE);
            encoding.priority = "high";
            encoding.networkPriority = "high";
        }

        parameters.encodings = encodings;

        await sender.setParameters(parameters);

        if (settings.store.verboseLogging) {
            console.info("[BetterScreenshare] Tuned sender:", sender.getParameters());
        }
    } catch (error) {
        if (settings.store.verboseLogging) {
            console.debug("[BetterScreenshare] Sender tuning was not fully accepted:", error);
        }
    }
}

function applyCodecPreferences(transceiver: RTCRtpTransceiver) {
    if (!settings.store.preferModernCodecs || typeof transceiver.setCodecPreferences !== "function") return;
    const codecs = orderedVideoCodecs();
    if (!codecs.length) return;

    try {
        transceiver.setCodecPreferences(codecs);
    } catch (error) {
        if (settings.store.verboseLogging) {
            console.debug("[BetterScreenshare] Codec preference rejected:", error);
        }
    }
}

function installHooks() {
    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices) {
        patchMethod(mediaDevices, "getDisplayMedia", original => async function (
            this: MediaDevices,
            constraints: DisplayMediaStreamOptions = {}
        ) {
            const modified = improveDisplayConstraints(constraints);
            if (settings.store.verboseLogging) {
                console.debug("[BetterScreenshare] getDisplayMedia:", constraints, "=>", modified);
            }

            const stream = await original.call(this, modified) as MediaStream;
            for (const track of stream.getVideoTracks()) markScreenTrack(track);
            return stream;
        });
    }

    patchMethod(RTCPeerConnection?.prototype, "addTrack", original => function (
        this: RTCPeerConnection,
        track: MediaStreamTrack,
        ...streams: MediaStream[]
    ) {
        const sender = original.call(this, track, ...streams) as RTCRtpSender;
        if (track.kind === "video" && screenTracks.has(track)) void tuneSender(sender);
        return sender;
    });

    patchMethod(RTCPeerConnection?.prototype, "addTransceiver", original => function (
        this: RTCPeerConnection,
        trackOrKind: MediaStreamTrack | string,
        init?: RTCRtpTransceiverInit
    ) {
        const transceiver = original.call(this, trackOrKind, init) as RTCRtpTransceiver;
        const track = typeof trackOrKind === "string" ? null : trackOrKind;

        if (track?.kind === "video" && screenTracks.has(track)) {
            applyCodecPreferences(transceiver);
            void tuneSender(transceiver.sender);
        }

        return transceiver;
    });

    patchMethod(RTCRtpSender?.prototype, "replaceTrack", original => async function (
        this: RTCRtpSender,
        withTrack: MediaStreamTrack | null
    ) {
        const result = await original.call(this, withTrack);
        if (withTrack?.kind === "video" && screenTracks.has(withTrack)) {
            void tuneSender(this);
        }
        return result;
    });
}

function formatMbps(value?: number) {
    return value == null || !Number.isFinite(value) ? "—" : (value / 1_000_000).toFixed(2);
}

async function collectDiagnostics() {
    const lines: string[] = ["Better Screenshare"];

    for (const sender of trackedSenders) {
        const track = sender.track;
        if (!track || track.readyState === "ended" || !screenTracks.has(track)) {
            trackedSenders.delete(sender);
            continue;
        }

        const s = track.getSettings();
        lines.push(`${s.width ?? "?"}×${s.height ?? "?"} @ ${s.frameRate ?? "?"} FPS`);

        const params = sender.getParameters();
        const target = params.encodings?.[params.encodings.length - 1]?.maxBitrate;
        lines.push(`Target: ${formatMbps(target)} Mbps`);

        try {
            const stats = await sender.getStats();
            let outbound: any = null;
            let codec: any = null;
            let remoteInbound: any = null;

            stats.forEach(report => {
                if (report.type === "outbound-rtp" && report.kind === "video") outbound = report;
                else if (report.type === "codec") codec = codec ?? report;
                else if (report.type === "remote-inbound-rtp") remoteInbound = report;
            });

            if (outbound) {
                const now = Number(outbound.timestamp ?? performance.now());
                const bytesSent = Number(outbound.bytesSent ?? 0);
                const previous = previousOutboundStats.get(sender);
                let sendBitrate: number | undefined;

                if (previous && now > previous.timestamp && bytesSent >= previous.bytesSent) {
                    sendBitrate = ((bytesSent - previous.bytesSent) * 8 * 1000) / (now - previous.timestamp);
                }
                previousOutboundStats.set(sender, { bytesSent, timestamp: now });

                lines.push(`Send/target: ${formatMbps(sendBitrate)} / ${formatMbps(target)} Mbps`);
                if (outbound.qualityLimitationReason) lines.push(`Quality limit: ${outbound.qualityLimitationReason}`);
                if (outbound.qpSum != null && outbound.framesEncoded) {
                    lines.push(`Avg QP: ${(outbound.qpSum / outbound.framesEncoded).toFixed(1)}`);
                }
                if (outbound.encoderImplementation) lines.push(`Encoder: ${outbound.encoderImplementation}`);
                if (outbound.powerEfficientEncoder != null) {
                    lines.push(`Power-efficient: ${outbound.powerEfficientEncoder ? "yes" : "no"}`);
                }
                if (outbound.scalabilityMode) lines.push(`Scalability: ${outbound.scalabilityMode}`);
            }

            if (outbound?.codecId) codec = stats.get(outbound.codecId) ?? codec;
            if (codec?.mimeType) lines.push(`Codec: ${codec.mimeType.replace("video/", "")}`);
            if (remoteInbound?.roundTripTime != null) lines.push(`RTT: ${Math.round(remoteInbound.roundTripTime * 1000)} ms`);
            if (remoteInbound?.fractionLost != null) lines.push(`Loss: ${(remoteInbound.fractionLost * 100).toFixed(2)}%`);
        } catch {}

        break;
    }

    if (lines.length === 1) lines.push("No active screen-share sender");
    return lines.join("\n");
}

function ensureOverlay() {
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.dataset.equicordBetterScreenshare = "true";
    Object.assign(overlay.style, {
        position: "fixed",
        top: "12px",
        right: "12px",
        zIndex: "2147483647",
        padding: "8px 10px",
        borderRadius: "6px",
        background: "rgba(0, 0, 0, 0.78)",
        color: "#fff",
        font: "12px/1.45 monospace",
        whiteSpace: "pre",
        pointerEvents: "none",
        maxWidth: "360px"
    });

    document.body.appendChild(overlay);
    return overlay;
}

async function refreshOverlay() {
    if (!settings.store.diagnosticsOverlay) return;
    const el = ensureOverlay();
    el.textContent = await collectDiagnostics();
}

function startOverlay() {
    stopOverlay();
    if (!settings.store.diagnosticsOverlay) return;
    void refreshOverlay();
    overlayTimer = window.setInterval(() => void refreshOverlay(), 1000);
}

function stopOverlay() {
    if (overlayTimer !== null) window.clearInterval(overlayTimer);
    overlayTimer = null;
    overlay?.remove();
    overlay = null;
}

export default definePlugin({
    name: "BetterScreenshare",
    description: "Improves WebRTC screen sharing with higher-quality capture/sender tuning, codec preferences and optional live diagnostics.",
    authors: [{ name: "Chaython", id: 1415804298771824740n }],
    tags: ["Voice", "Media"],
    settings,

    start() {
        restorePatches();
        installHooks();
        if (settings.store.diagnosticsOverlay) startOverlay();
    },

    stop() {
        stopOverlay();
        restorePatches();
        trackedSenders.clear();
    }
});
