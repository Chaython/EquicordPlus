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

interface PreviousOutboundStats {
    bytesSent: number;
    framesEncoded: number;
    totalEncodeTime: number;
    timestamp: number;
}

const patches: MethodPatch[] = [];
const trackedSenders = new Set<RTCRtpSender>();
const previousOutboundStats = new WeakMap<RTCRtpSender, PreviousOutboundStats>();
let overlay: HTMLDivElement | null = null;
let overlayTimer: number | null = null;

const settings = definePluginSettings({
    diagnosticsOverlay: {
        type: OptionType.BOOLEAN,
        displayName: "Diagnostics Overlay",
        description: "Show live read-only WebRTC stats for the active screen share. This does not change capture, encoding, bitrate, FPS, scaling, or codecs.",
        default: false,
        onChange(value) {
            if (value) startOverlay();
            else stopOverlay();
        }
    },
    verboseLogging: {
        type: OptionType.BOOLEAN,
        displayName: "Console Logging",
        description: "Write observed screen-share sender and WebRTC stats to the console for troubleshooting. No stream settings are changed.",
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
        if (settings.store.verboseLogging) {
            console.debug(`[BetterScreenshare] Could not observe ${key}:`, error);
        }
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
            if (settings.store.verboseLogging) {
                console.debug(`[BetterScreenshare] Could not restore ${patch.key}:`, error);
            }
        }
    }
}

function isLikelyScreenTrack(track: MediaStreamTrack | null | undefined) {
    if (!track || track.kind !== "video") return false;

    try {
        const settings = track.getSettings() as MediaTrackSettings & { displaySurface?: string; };
        if (settings.displaySurface) return true;
    } catch {}

    return /screen|window|desktop|display|monitor/i.test(track.label);
}

function trackSender(sender: RTCRtpSender) {
    if (!isLikelyScreenTrack(sender.track)) return;
    trackedSenders.add(sender);

    const track = sender.track!;
    track.addEventListener("ended", () => {
        trackedSenders.delete(sender);
        previousOutboundStats.delete(sender);
    }, { once: true });

    if (settings.store.verboseLogging) {
        console.info("[BetterScreenshare] Observing screen-share sender:", sender);
    }
}

function installObserverHooks() {
    patchMethod(RTCPeerConnection?.prototype, "addTrack", original => function (
        this: RTCPeerConnection,
        track: MediaStreamTrack,
        ...streams: MediaStream[]
    ) {
        const sender = original.call(this, track, ...streams) as RTCRtpSender;
        trackSender(sender);
        return sender;
    });

    patchMethod(RTCPeerConnection?.prototype, "addTransceiver", original => function (
        this: RTCPeerConnection,
        trackOrKind: MediaStreamTrack | string,
        init?: RTCRtpTransceiverInit
    ) {
        const transceiver = original.call(this, trackOrKind, init) as RTCRtpTransceiver;
        trackSender(transceiver.sender);
        return transceiver;
    });

    patchMethod(RTCRtpSender?.prototype, "replaceTrack", original => async function (
        this: RTCRtpSender,
        withTrack: MediaStreamTrack | null
    ) {
        const result = await original.call(this, withTrack);

        if (isLikelyScreenTrack(withTrack)) {
            trackSender(this);
        } else {
            trackedSenders.delete(this);
            previousOutboundStats.delete(this);
        }

        return result;
    });
}

function formatMbps(value?: number) {
    return value == null || !Number.isFinite(value) ? "—" : (value / 1_000_000).toFixed(2);
}

function formatNumber(value?: number, digits = 1) {
    return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

async function collectDiagnostics() {
    const lines: string[] = ["Screen-share diagnostics"];

    for (const sender of [...trackedSenders]) {
        const track = sender.track;
        if (!track || track.readyState === "ended" || !isLikelyScreenTrack(track)) {
            trackedSenders.delete(sender);
            previousOutboundStats.delete(sender);
            continue;
        }

        const trackSettings = track.getSettings();
        lines.push(`Capture: ${trackSettings.width ?? "?"}×${trackSettings.height ?? "?"} @ ${trackSettings.frameRate ?? "?"} FPS`);

        try {
            const stats = await sender.getStats();
            let outbound: any = null;
            let codec: any = null;
            let remoteInbound: any = null;
            let mediaSource: any = null;
            let selectedCandidatePair: any = null;
            let transport: any = null;

            stats.forEach(report => {
                if (report.type === "outbound-rtp" && (report.kind === "video" || report.mediaType === "video")) {
                    if (!outbound || Number(report.bytesSent ?? 0) > Number(outbound.bytesSent ?? 0)) outbound = report;
                } else if (report.type === "remote-inbound-rtp") {
                    remoteInbound = report;
                } else if (report.type === "media-source" && report.kind === "video") {
                    mediaSource = report;
                } else if (report.type === "transport") {
                    transport = report;
                } else if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
                    selectedCandidatePair = report;
                }
            });

            if (transport?.selectedCandidatePairId) {
                selectedCandidatePair = stats.get(transport.selectedCandidatePairId) ?? selectedCandidatePair;
            }

            if (!outbound) {
                lines.push("No outbound RTP stats yet");
                break;
            }

            if (outbound.codecId) codec = stats.get(outbound.codecId);

            const now = Number(outbound.timestamp ?? performance.now());
            const bytesSent = Number(outbound.bytesSent ?? 0);
            const framesEncoded = Number(outbound.framesEncoded ?? 0);
            const totalEncodeTime = Number(outbound.totalEncodeTime ?? 0);
            const previous = previousOutboundStats.get(sender);

            let sendBitrate: number | undefined;
            let encodedFps: number | undefined;
            let encodeMsPerFrame: number | undefined;

            if (previous && now > previous.timestamp) {
                const elapsedMs = now - previous.timestamp;

                if (bytesSent >= previous.bytesSent) {
                    sendBitrate = ((bytesSent - previous.bytesSent) * 8 * 1000) / elapsedMs;
                }

                const frameDelta = framesEncoded - previous.framesEncoded;
                if (frameDelta >= 0) {
                    encodedFps = frameDelta * 1000 / elapsedMs;

                    const encodeTimeDelta = totalEncodeTime - previous.totalEncodeTime;
                    if (frameDelta > 0 && encodeTimeDelta >= 0) {
                        encodeMsPerFrame = encodeTimeDelta * 1000 / frameDelta;
                    }
                }
            }

            previousOutboundStats.set(sender, {
                bytesSent,
                framesEncoded,
                totalEncodeTime,
                timestamp: now
            });

            const params = sender.getParameters();
            const encodingTargets = params.encodings ?? [];
            const targetBitrate = encodingTargets.reduce(
                (max, encoding) => Math.max(max, Number(encoding.maxBitrate ?? 0)),
                0
            ) || undefined;

            lines.push(`Encoded: ${formatNumber(encodedFps)} FPS`);
            lines.push(`Encode time: ${formatNumber(encodeMsPerFrame)} ms/frame`);
            lines.push(`Bitrate: ${formatMbps(sendBitrate)} Mbps${targetBitrate ? ` / ceiling ${formatMbps(targetBitrate)}` : ""}`);

            if (mediaSource?.framesPerSecond != null) {
                lines.push(`Source FPS: ${formatNumber(Number(mediaSource.framesPerSecond))}`);
            }
            if (outbound.framesPerSecond != null) {
                lines.push(`Outbound FPS: ${formatNumber(Number(outbound.framesPerSecond))}`);
            }
            if (outbound.framesSent != null) lines.push(`Frames sent: ${outbound.framesSent}`);
            if (outbound.framesEncoded != null) lines.push(`Frames encoded: ${outbound.framesEncoded}`);
            if (outbound.framesDropped != null) lines.push(`Frames dropped: ${outbound.framesDropped}`);
            if (outbound.qualityLimitationReason) lines.push(`Quality limit: ${outbound.qualityLimitationReason}`);
            if (outbound.qualityLimitationDurations) {
                const d = outbound.qualityLimitationDurations;
                lines.push(`Limit seconds — CPU: ${formatNumber(Number(d.cpu ?? 0))}, bandwidth: ${formatNumber(Number(d.bandwidth ?? 0))}`);
            }
            if (outbound.qpSum != null && outbound.framesEncoded) {
                lines.push(`Avg QP: ${formatNumber(outbound.qpSum / outbound.framesEncoded)}`);
            }
            if (codec?.mimeType) lines.push(`Codec: ${codec.mimeType.replace("video/", "")}`);
            if (outbound.encoderImplementation) lines.push(`Encoder: ${outbound.encoderImplementation}`);
            if (outbound.powerEfficientEncoder != null) {
                lines.push(`Power-efficient: ${outbound.powerEfficientEncoder ? "yes" : "no"}`);
            }
            if (outbound.scalabilityMode) lines.push(`Scalability: ${outbound.scalabilityMode}`);
            if (selectedCandidatePair?.availableOutgoingBitrate != null) {
                lines.push(`BWE available: ${formatMbps(Number(selectedCandidatePair.availableOutgoingBitrate))} Mbps`);
            }
            if (selectedCandidatePair?.currentRoundTripTime != null) {
                lines.push(`ICE RTT: ${Math.round(Number(selectedCandidatePair.currentRoundTripTime) * 1000)} ms`);
            }
            if (remoteInbound?.roundTripTime != null) {
                lines.push(`RTT: ${Math.round(remoteInbound.roundTripTime * 1000)} ms`);
            }
            if (remoteInbound?.fractionLost != null) {
                lines.push(`Loss: ${(remoteInbound.fractionLost * 100).toFixed(2)}%`);
            }
            if (outbound.retransmittedBytesSent != null) {
                lines.push(`Retransmit: ${formatMbps(Number(outbound.retransmittedBytesSent) * 8)} Mbit total`);
            }
            if (outbound.nackCount != null || outbound.pliCount != null || outbound.firCount != null) {
                lines.push(`NACK/PLI/FIR: ${outbound.nackCount ?? 0}/${outbound.pliCount ?? 0}/${outbound.firCount ?? 0}`);
            }
        } catch (error) {
            lines.push("Stats unavailable");
            if (settings.store.verboseLogging) {
                console.debug("[BetterScreenshare] Could not read sender stats:", error);
            }
        }

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
        maxWidth: "420px"
    });

    document.body.appendChild(overlay);
    return overlay;
}

async function refreshOverlay() {
    if (!settings.store.diagnosticsOverlay) return;
    const element = ensureOverlay();
    element.textContent = await collectDiagnostics();
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
    description: "Read-only WebRTC screen-share diagnostics. Equicord and Discord retain full control of capture, codecs, bitrate, FPS, scaling, and encoder settings.",
    authors: [{ name: "Chaython", id: 1415804298771824740n }],
    tags: ["Voice", "Utility"],
    searchTerms: ["WebRTC", "Screen Share", "Encoder", "Dropped Frames", "Diagnostics"],
    settings,

    start() {
        restorePatches();
        installObserverHooks();
        if (settings.store.diagnosticsOverlay) startOverlay();
    },

    stop() {
        stopOverlay();
        restorePatches();
        trackedSenders.clear();
    }
});
