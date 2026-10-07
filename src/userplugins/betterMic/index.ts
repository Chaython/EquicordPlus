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

const settings = definePluginSettings({
    disableEchoCancellation: {
        type: OptionType.BOOLEAN,
        description: "Disable Chromium/WebRTC echo cancellation for microphone capture",
        default: true
    },
    disableNoiseSuppression: {
        type: OptionType.BOOLEAN,
        description: "Disable Chromium/WebRTC noise suppression for microphone capture",
        default: true
    },
    disableAutoGainControl: {
        type: OptionType.BOOLEAN,
        description: "Disable Chromium/WebRTC automatic gain control for microphone capture",
        default: true
    },
    prefer48kHz: {
        type: OptionType.BOOLEAN,
        description: "Prefer 48 kHz microphone capture when the device supports it",
        default: true
    },
    preferStereo: {
        type: OptionType.BOOLEAN,
        description: "Prefer stereo microphone capture when the device supports it",
        default: true
    },
    verboseLogging: {
        type: OptionType.BOOLEAN,
        description: "Log requested constraints plus active microphone settings/capabilities to the console",
        default: false
    }
});

function getAudioOverrides(): MediaTrackConstraints {
    const overrides: MediaTrackConstraints = {};

    if (settings.store.disableEchoCancellation) overrides.echoCancellation = false;
    if (settings.store.disableNoiseSuppression) overrides.noiseSuppression = false;
    if (settings.store.disableAutoGainControl) overrides.autoGainControl = false;
    if (settings.store.prefer48kHz) overrides.sampleRate = { ideal: 48_000 };
    if (settings.store.preferStereo) overrides.channelCount = { ideal: 2 };

    return overrides;
}

function makeRawAudioConstraints(original: boolean | MediaTrackConstraints | undefined): boolean | MediaTrackConstraints {
    if (original === false) return false;

    const audio: MediaTrackConstraints = original && typeof original === "object"
        ? { ...original }
        : {};

    if (Array.isArray(audio.advanced)) {
        audio.advanced = audio.advanced.map(entry => ({
            ...entry,
            ...(settings.store.disableEchoCancellation ? { echoCancellation: false } : {}),
            ...(settings.store.disableNoiseSuppression ? { noiseSuppression: false } : {}),
            ...(settings.store.disableAutoGainControl ? { autoGainControl: false } : {})
        }));
    }

    return {
        ...audio,
        ...getAudioOverrides()
    };
}

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
        console.warn(`[BetterMic] Could not patch ${key}:`, error);
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
            console.warn(`[BetterMic] Could not restore ${patch.key}:`, error);
        }
    }
}

function installHooks() {
    patchMethod(MediaStreamTrack?.prototype, "applyConstraints", original => function (
        this: MediaStreamTrack,
        constraints: MediaTrackConstraints = {}
    ) {
        if (this.kind !== "audio") return original.call(this, constraints);

        const modified = makeRawAudioConstraints(constraints) as MediaTrackConstraints;
        if (settings.store.verboseLogging) {
            console.debug("[BetterMic] applyConstraints:", constraints, "=>", modified);
        }
        return original.call(this, modified);
    });

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices) return;

    patchMethod(mediaDevices, "getUserMedia", original => async function (
        this: MediaDevices,
        constraints: MediaStreamConstraints = {}
    ) {
        if (!constraints?.audio) return original.call(this, constraints);

        const modified: MediaStreamConstraints = {
            ...constraints,
            audio: makeRawAudioConstraints(constraints.audio as boolean | MediaTrackConstraints)
        };

        if (settings.store.verboseLogging) {
            console.debug("[BetterMic] getUserMedia:", constraints, "=>", modified);
        }

        const stream = await original.call(this, modified) as MediaStream;
        const overrides = getAudioOverrides();

        for (const track of stream.getAudioTracks()) {
            try {
                await track.applyConstraints(overrides);
            } catch (error) {
                if (settings.store.verboseLogging) {
                    console.debug("[BetterMic] Some preferred post-capture constraints were rejected:", error);
                }
            }

            if (!settings.store.verboseLogging) continue;
            console.info("[BetterMic] Active settings:", track.getSettings());
            try {
                console.info("[BetterMic] Capabilities:", track.getCapabilities());
            } catch {}
        }

        return stream;
    });
}

export default definePlugin({
    name: "BetterMic",
    description: "Improves microphone capture quality by disabling Chromium processing and preferring raw 48 kHz/stereo audio.",
    authors: [{ name: "Chaython", id: 1415804298771824740n }],
    tags: ["Voice", "Media"],
    settings,

    start() {
        restorePatches();
        installHooks();
    },

    stop() {
        restorePatches();
    }
});
