/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import {
    Divider,
    Span,
} from "@components/index";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Checkbox, closeModal, Modal, openModal, Text, } from "@webpack/common";

import managedStyle from "./styles.css?managed";

const cl = classNameFactory("vc-screen-picker-");

class NotAllowedError extends Error {
    name = "NotAllowedError";
}

const logger = new Logger("VencordScreenShare");

const getDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
const customScreenTracks = new WeakSet<MediaStreamTrack>();
const senderTransceivers = new WeakMap<RTCRtpSender, RTCRtpTransceiver>();

interface MethodPatch {
    target: any;
    key: string;
    hadOwn: boolean;
    descriptor?: PropertyDescriptor;
    replacement: Function;
}

const methodPatches: MethodPatch[] = [];

const StreamResolution = ["480", "720", "1080", "1440", "2160"] as const;
const StreamFps = ["15", "30", "60", "120"] as const;
const StreamContentHint = ["motion", "detail", ""] as const;
const CustomContentHints = ["", "motion", "detail", "text"] as const;
const CustomDegradationPreferences = ["auto", "balanced", "maintain-framerate", "maintain-resolution"] as const;
const CustomPriorities = ["auto", "very-low", "low", "medium", "high"] as const;

const settings = definePluginSettings({
    resolution: {
        type: OptionType.SELECT,
        description: "Resolution",
        hidden: true,
        options: StreamResolution.map(res => ({ label: res, value: res, default: res === "1080" }))
    },
    frameRate: {
        type: OptionType.SELECT,
        description: "Frame Rate",
        hidden: true,
        options: StreamFps.map(fps => ({ label: fps, value: fps, default: fps === "60" }))
    },
    contentHint: {
        type: OptionType.SELECT,
        description: "Content Hint",
        hidden: true,
        options: StreamContentHint.map(hint => ({ label: hint, value: hint, default: hint === "motion" }))
    },
    systemAudio: {
        type: OptionType.BOOLEAN,
        description: "Mute system audio",
        hidden: true
    },
    customContentHint: {
        type: OptionType.SELECT,
        description: "Custom content hint",
        hidden: true,
        options: CustomContentHints.map(hint => ({
            label: hint || "Automatic",
            value: hint,
            default: hint === ""
        }))
    },
    customCodec: {
        type: OptionType.STRING,
        description: "Preferred custom WebRTC video codec",
        default: "auto",
        hidden: true
    },
    customMinBitrateKbps: {
        type: OptionType.NUMBER,
        description: "Custom minimum bitrate in kbps (0 = automatic)",
        default: 0,
        hidden: true
    },
    customTargetBitrateKbps: {
        type: OptionType.NUMBER,
        description: "Custom target bitrate in kbps (0 = automatic)",
        default: 0,
        hidden: true
    },
    customMaxBitrateKbps: {
        type: OptionType.NUMBER,
        description: "Custom maximum bitrate in kbps (0 = automatic)",
        default: 0,
        hidden: true
    },
    customEncoderMaxFps: {
        type: OptionType.NUMBER,
        description: "Custom RTP encoder FPS cap (0 = automatic)",
        default: 0,
        hidden: true
    },
    customScaleResolutionDownBy: {
        type: OptionType.NUMBER,
        description: "Custom RTP resolution downscale factor (0 = automatic)",
        default: 0,
        hidden: true
    },
    customDegradationPreference: {
        type: OptionType.SELECT,
        description: "Custom WebRTC degradation preference",
        hidden: true,
        options: CustomDegradationPreferences.map(value => ({
            label: value,
            value,
            default: value === "auto"
        }))
    },
    customPriority: {
        type: OptionType.SELECT,
        description: "Custom RTP sender priority",
        hidden: true,
        options: CustomPriorities.map(value => ({
            label: value,
            value,
            default: value === "auto"
        }))
    },
    customNetworkPriority: {
        type: OptionType.SELECT,
        description: "Custom RTP network priority",
        hidden: true,
        options: CustomPriorities.map(value => ({
            label: value,
            value,
            default: value === "auto"
        }))
    },
    customKeyframeIntervalMs: {
        type: OptionType.NUMBER,
        description: "Custom Discord encoder keyframe interval in milliseconds (0 = encoder default)",
        default: 0,
        hidden: true
    }
});

type LiveSettings = ReturnType<typeof settings.use>;

function openScreenSharePicker(options: DisplayMediaStreamOptions) {
    return new Promise<MediaStream>((resolve, reject) => {
        const key = openModal(
            props => (
                <ModalComponent
                    modalProps={props}
                    submit={resolve}
                    options={options}
                    close={() => {
                        props.onClose();
                        reject(new NotAllowedError("Permission denied by user"));
                    }}
                />
            ),
            {
                onCloseRequest() {
                    closeModal(key);
                    reject(new NotAllowedError("Permission denied by user"));
                },
                onCloseCallback() {
                    reject(new NotAllowedError("Permission denied by user"));
                }
            }
        );
    });
}

function OptionRadio<Settings extends object, Key extends keyof Settings, Options extends ReadonlyArray<string>>(props: {
    options: Options;
    labels?: Array<string>;
    settings: Settings;
    settingsKey: Key;
    onChange: (option: Options[number]) => void;
}) {
    const { options, settings, settingsKey, labels, onChange } = props;

    return (
        <div className={cl("padding")}>
            <div className={cl("option-radios")}>
                {options.map((option, idx) => (
                    <label className={cl("option-radio")} data-checked={settings[settingsKey] === option} key={option}>
                        <Span weight="bold">{labels?.[idx] ?? option}</Span>
                        <input
                            type="radio"
                            name={settingsKey.toString()}
                            value={option}
                            checked={settings[settingsKey] === option}
                            onChange={() => onChange(option)}
                        />
                    </label>
                ))}
            </div>
        </div>
    );
}

function getSupportedVideoCodecNames() {
    const capabilities = RTCRtpReceiver.getCapabilities?.("video");
    const names = new Map<string, string>();

    for (const codec of capabilities?.codecs ?? []) {
        const mime = codec.mimeType;
        if (!mime?.toLowerCase().startsWith("video/")) continue;

        const name = mime.slice("video/".length);
        if (/^(rtx|red|ulpfec|flexfec)/i.test(name)) continue;
        names.set(mime.toLowerCase(), name.toUpperCase());
    }

    return [...names].map(([value, label]) => ({ value, label }));
}

function AdvancedSelect({ label, description, value, options, onChange }: {
    label: string;
    description: string;
    value: string;
    options: Array<{ value: string; label: string; }>;
    onChange(value: string): void;
}) {
    return (
        <label className={cl("advanced-field")}>
            <span className={cl("advanced-label")}>{label}</span>
            <select value={value} onChange={event => onChange(event.currentTarget.value)}>
                {options.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}
            </select>
            <span className={cl("advanced-description")}>{description}</span>
        </label>
    );
}

function AdvancedNumber({ label, description, value, min = 0, max, step = 1, onChange }: {
    label: string;
    description: string;
    value: number;
    min?: number;
    max?: number;
    step?: number;
    onChange(value: number): void;
}) {
    return (
        <label className={cl("advanced-field")}>
            <span className={cl("advanced-label")}>{label}</span>
            <input
                type="number"
                min={min}
                max={max}
                step={step}
                value={Number.isFinite(value) ? value : 0}
                onChange={event => {
                    const parsed = Number(event.currentTarget.value);
                    if (!Number.isFinite(parsed)) return;
                    onChange(Math.max(min, max == null ? parsed : Math.min(max, parsed)));
                }}
            />
            <span className={cl("advanced-description")}>{description}</span>
        </label>
    );
}

function CustomAdvancedSettings({ liveSettings }: { liveSettings: LiveSettings; }) {
    const codecs = [{ value: "auto", label: "Automatic (Discord/Chromium)" }, ...getSupportedVideoCodecNames()];

    return (
        <div className={cl("advanced")}>
            <Text tag="h2" variant="heading-md/semibold" color="text-strong">Advanced WebRTC encoder settings</Text>
            <Text variant="text-sm/normal" color="text-subtle">
                These apply only to Custom mode. 0/Automatic leaves that setting under Discord/Chromium control.
                Browser WebRTC does not expose arbitrary FFmpeg presets, CRF/QP targets, B-frames, or direct GPU/NVENC selection.
            </Text>

            <div className={cl("advanced-grid")}>
                <AdvancedSelect
                    label="Preferred codec"
                    description="Moves the selected codec to the front of WebRTC negotiation while retaining fallback codecs."
                    value={liveSettings.customCodec ?? "auto"}
                    options={codecs}
                    onChange={value => (liveSettings.customCodec = value)}
                />
                <AdvancedSelect
                    label="Content hint"
                    description="Automatic, motion, detail, or text. Text is the strongest sharp-edge/text hint supported by MediaStreamTrack."
                    value={liveSettings.customContentHint ?? ""}
                    options={[
                        { value: "", label: "Automatic" },
                        { value: "motion", label: "Motion / gaming" },
                        { value: "detail", label: "Detail" },
                        { value: "text", label: "Text / sharp edges" },
                    ]}
                    onChange={value => (liveSettings.customContentHint = value as typeof CustomContentHints[number])}
                />
                <AdvancedNumber
                    label="Minimum bitrate (kbps)"
                    description="Discord encoder minimum. 0 keeps Discord's current value."
                    value={liveSettings.customMinBitrateKbps ?? 0}
                    max={80000}
                    step={100}
                    onChange={value => (liveSettings.customMinBitrateKbps = value)}
                />
                <AdvancedNumber
                    label="Target bitrate (kbps)"
                    description="Discord encoder target. 0 keeps Discord's current value."
                    value={liveSettings.customTargetBitrateKbps ?? 0}
                    max={80000}
                    step={100}
                    onChange={value => (liveSettings.customTargetBitrateKbps = value)}
                />
                <AdvancedNumber
                    label="Maximum bitrate (kbps)"
                    description="Discord max plus the main RTP encoding max. WebScreenShareFixes currently keeps the SDP ceiling at 80,000 kbps."
                    value={liveSettings.customMaxBitrateKbps ?? 0}
                    max={80000}
                    step={100}
                    onChange={value => (liveSettings.customMaxBitrateKbps = value)}
                />
                <AdvancedNumber
                    label="Encoder FPS cap"
                    description="Caps the main RTP encoding. 0 leaves the sender cap unchanged; capture FPS is still selected above."
                    value={liveSettings.customEncoderMaxFps ?? 0}
                    max={240}
                    onChange={value => (liveSettings.customEncoderMaxFps = value)}
                />
                <AdvancedNumber
                    label="Resolution downscale"
                    description="RTP scaleResolutionDownBy. 1 = native encoded size, 2 = half width/height. 0 leaves Discord's scaling untouched."
                    value={liveSettings.customScaleResolutionDownBy ?? 0}
                    min={0}
                    max={8}
                    step={0.25}
                    onChange={value => (liveSettings.customScaleResolutionDownBy = value)}
                />
                <AdvancedSelect
                    label="Degradation preference"
                    description="Chooses whether WebRTC should favor frame rate, resolution, or balance when resources are constrained."
                    value={liveSettings.customDegradationPreference ?? "auto"}
                    options={[
                        { value: "auto", label: "Automatic" },
                        { value: "balanced", label: "Balanced" },
                        { value: "maintain-framerate", label: "Maintain frame rate" },
                        { value: "maintain-resolution", label: "Maintain resolution" },
                    ]}
                    onChange={value => (liveSettings.customDegradationPreference = value as typeof CustomDegradationPreferences[number])}
                />
                <AdvancedSelect
                    label="RTP priority"
                    description="Bandwidth allocation priority for the main screen-share encoding."
                    value={liveSettings.customPriority ?? "auto"}
                    options={[
                        { value: "auto", label: "Automatic" },
                        { value: "very-low", label: "Very low" },
                        { value: "low", label: "Low" },
                        { value: "medium", label: "Medium" },
                        { value: "high", label: "High" },
                    ]}
                    onChange={value => (liveSettings.customPriority = value as typeof CustomPriorities[number])}
                />
                <AdvancedSelect
                    label="Network priority"
                    description="Chromium network priority hint when the browser exposes it."
                    value={liveSettings.customNetworkPriority ?? "auto"}
                    options={[
                        { value: "auto", label: "Automatic" },
                        { value: "very-low", label: "Very low" },
                        { value: "low", label: "Low" },
                        { value: "medium", label: "Medium" },
                        { value: "high", label: "High" },
                    ]}
                    onChange={value => (liveSettings.customNetworkPriority = value as typeof CustomPriorities[number])}
                />
                <AdvancedNumber
                    label="Keyframe interval (ms)"
                    description="Uses Discord's encoder keyframe interval when that encoder path is present. 0 keeps its default."
                    value={liveSettings.customKeyframeIntervalMs ?? 0}
                    max={60000}
                    step={250}
                    onChange={value => (liveSettings.customKeyframeIntervalMs = value)}
                />
            </div>
        </div>
    );
}

function ModalComponent({ modalProps, submit, close, options }: {
    modalProps: any;
    submit: (data: Promise<MediaStream>) => void;
    close: () => void;
    options: DisplayMediaStreamOptions;
}) {
    const liveSettings = settings.use();
    const disableStreamPreviewsValue = disableStreamPreviews.useSetting();

    async function stream() {
        try {
            const frameRate = Number(liveSettings.frameRate);
            const height = Number(liveSettings.resolution);
            const customMode = liveSettings.contentHint === "";

            const videoOptions = typeof options?.video !== "boolean" && !!options.video ? { ...options.video } : {};
            const audioOptions = typeof options?.audio !== "boolean" && !!options.audio ? { ...options.audio } : {};

            // Allow the browser to preserve the source aspect ratio.
            delete videoOptions.width;

            submit(
                getDisplayMedia({
                    video: {
                        ...videoOptions,
                        frameRate,
                        height,
                    },
                    audio: {
                        ...audioOptions,
                        restrictOwnAudio: true,
                    },
                    surfaceSwitching: "include",
                    systemAudio: liveSettings.systemAudio ? "exclude" : "include"
                }).then(stream => {
                    try {
                        const video = stream.getVideoTracks()?.[0];
                        if (video) {
                            video.contentHint = customMode
                                ? liveSettings.customContentHint ?? ""
                                : liveSettings.contentHint;

                            if (customMode) customScreenTracks.add(video);
                        }
                    } catch (error) {
                        logger.debug("Could not apply screen-share content hint.", error);
                    }
                    return stream;
                })
            );
        } catch (error) {
            logger.error("Error while submitting stream.", error);
        } finally {
            close();
        }
    }

    return (
        <div className={cl("modal")}>
            <Modal
                {...modalProps}
                size="lg"
                actionBarInput={
                    <div className={cl("summary")}>
                        <Text variant="text-md/semibold" color="text-strong" className={cl("source-or-preset-name")}>{liveSettings.contentHint === "motion" ? "Gaming" : liveSettings.contentHint === "detail" ? "Screenshare" : "Custom"}</Text>
                        <Text variant="text-xs/medium" color="text-muted" className={cl("summary-detail")}>
                            <span>{liveSettings.contentHint === "motion" ? "Smoother video" : liveSettings.contentHint === "detail" ? "Cleaner text" : "Advanced WebRTC"}</span>
                            <span className={cl("ellipsis")}>•</span>
                            <span>{liveSettings.resolution}p</span>
                            <span className={cl("ellipsis")}>•</span>
                            <span>{liveSettings.frameRate}fps</span>
                            {liveSettings.systemAudio ? <span className={cl("ellipsis")}>•</span> : ""}
                            {liveSettings.systemAudio ? <span>Stream Muted</span> : ""}
                        </Text>
                    </div>
                }
                actions={[
                    {
                        variant: "primary",
                        text: "Stream",
                        onClick: stream
                    }
                ]}>

                <div>
                    <div className={cl("flex", "padding")}>
                        <section className={cl("quality-section")}>
                            <Text tag="h2" variant="heading-md/semibold" color="text-strong">Resolution</Text>
                            <OptionRadio
                                options={StreamResolution}
                                settings={liveSettings}
                                settingsKey="resolution"
                                onChange={value => (liveSettings.resolution = value)}
                            />
                        </section>

                        <section className={cl("quality-section")}>
                            <Text tag="h2" variant="heading-md/semibold" color="text-strong">Frame Rate</Text>
                            <OptionRadio
                                options={StreamFps}
                                settings={liveSettings}
                                settingsKey="frameRate"
                                onChange={value => (liveSettings.frameRate = value)}
                            />
                        </section>
                    </div>

                    <div>
                        <Text tag="h2" variant="heading-md/semibold" color="text-strong">Stream Mode</Text>
                        <OptionRadio
                            options={StreamContentHint}
                            labels={["Smoother video", "Cleaner text", "Custom"]}
                            settings={liveSettings}
                            settingsKey="contentHint"
                            onChange={option => (liveSettings.contentHint = option)}
                        />
                    </div>

                    {liveSettings.contentHint === "" && <CustomAdvancedSettings liveSettings={liveSettings} />}

                    <Divider />
                    <div className={cl("padding", "pointer")}>
                        <Checkbox
                            value={!!liveSettings.systemAudio}
                            onChange={(_e, value) => (liveSettings.systemAudio = value)}
                            shape="box"
                            reverse={true}>
                            <div className={cl("control-content")}>
                                <Text tag="h2" variant="heading-md/semibold" color="text-strong">Mute Stream Audio</Text>
                                <Text variant="text-sm/normal" color="text-subtle">Prevents system audio from being included in your stream.</Text>
                            </div>
                        </Checkbox>
                    </div>
                    <div className={cl("padding", "pointer")}>
                        <Checkbox
                            value={!disableStreamPreviewsValue}
                            onChange={(_e, value) => disableStreamPreviews.updateSetting(() => !value)}
                            shape="box"
                            reverse={true}>
                            <div className={cl("control-content")}>
                                <Text tag="h2" variant="heading-md/semibold" color="text-strong">Show Stream Previews</Text>
                                <Text variant="text-sm/normal" color="text-subtle">Allows others to see a preview of your stream before they join.</Text>
                            </div>
                        </Checkbox>
                    </div>
                    <Divider />
                </div>
            </Modal>
        </div>
    );
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
        methodPatches.push({ target, key, hadOwn, descriptor, replacement });
    } catch (error) {
        logger.debug(`Could not patch ${key} for custom screen-share settings.`, error);
    }
}

function restoreMethodPatches() {
    for (const patch of methodPatches.splice(0).reverse()) {
        if (patch.target?.[patch.key] !== patch.replacement) continue;

        try {
            if (patch.hadOwn && patch.descriptor) Object.defineProperty(patch.target, patch.key, patch.descriptor);
            else delete patch.target[patch.key];
        } catch (error) {
            logger.debug(`Could not restore ${patch.key}.`, error);
        }
    }
}

function isCustomScreenSender(sender: RTCRtpSender) {
    return !!sender.track && customScreenTracks.has(sender.track);
}

function applyCustomCodecPreference(transceiver: RTCRtpTransceiver) {
    const selected = (settings.store.customCodec ?? "auto").toLowerCase();
    if (selected === "auto" || typeof transceiver.setCodecPreferences !== "function") return;

    const codecs = transceiver.receiver.getCapabilities?.("video")?.codecs
        ?? RTCRtpReceiver.getCapabilities?.("video")?.codecs;
    if (!codecs?.length) return;

    const sorted = [...codecs].sort((a, b) => {
        const aPreferred = a.mimeType.toLowerCase() === selected ? 0 : 1;
        const bPreferred = b.mimeType.toLowerCase() === selected ? 0 : 1;
        return aPreferred - bPreferred;
    });

    try {
        transceiver.setCodecPreferences(sorted);
    } catch (error) {
        logger.debug("Could not apply preferred WebRTC codec.", error);
    }
}

function getCustomBitrates() {
    let min = Math.max(0, Number(settings.store.customMinBitrateKbps ?? 0)) * 1000;
    let target = Math.max(0, Number(settings.store.customTargetBitrateKbps ?? 0)) * 1000;
    let max = Math.max(0, Number(settings.store.customMaxBitrateKbps ?? 0)) * 1000;

    if (max > 0) {
        if (target > max) target = max;
        if (min > max) min = max;
    }
    if (target > 0 && min > target) min = target;

    return { min, target, max };
}

async function applyCustomSenderParameters(sender: RTCRtpSender) {
    if (!isCustomScreenSender(sender)) return;

    try {
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) return;

        const encoding = parameters.encodings.reduce((best, current) => {
            const bestScale = best.scaleResolutionDownBy ?? 1;
            const currentScale = current.scaleResolutionDownBy ?? 1;
            return currentScale < bestScale ? current : best;
        });

        const { max } = getCustomBitrates();
        const maxFps = Math.max(0, Number(settings.store.customEncoderMaxFps ?? 0));
        const scale = Math.max(0, Number(settings.store.customScaleResolutionDownBy ?? 0));
        const priority = settings.store.customPriority ?? "auto";
        const networkPriority = settings.store.customNetworkPriority ?? "auto";
        const degradation = settings.store.customDegradationPreference ?? "auto";

        if (max > 0) encoding.maxBitrate = max;
        if (maxFps > 0) encoding.maxFramerate = maxFps;
        if (scale >= 1) encoding.scaleResolutionDownBy = scale;
        if (priority !== "auto") encoding.priority = priority as RTCPriorityType;
        if (networkPriority !== "auto") {
            (encoding as RTCRtpEncodingParameters & { networkPriority?: RTCPriorityType; }).networkPriority = networkPriority as RTCPriorityType;
        }
        if (degradation !== "auto") parameters.degradationPreference = degradation as RTCDegradationPreference;

        await sender.setParameters(parameters);
    } catch (error) {
        logger.debug("Could not apply one or more Custom WebRTC sender parameters.", error);
    }
}

function configureCustomSender(peerConnection: RTCPeerConnection, sender: RTCRtpSender) {
    if (!isCustomScreenSender(sender)) return;

    const transceiver = peerConnection.getTransceivers().find(candidate => candidate.sender === sender);
    if (transceiver) {
        senderTransceivers.set(sender, transceiver);
        applyCustomCodecPreference(transceiver);
    }

    void applyCustomSenderParameters(sender);

    // Chromium may populate encodings only after the sender has moved further
    // through negotiation. Retry once without touching non-Custom streams.
    window.setTimeout(() => {
        if (isCustomScreenSender(sender)) void applyCustomSenderParameters(sender);
    }, 500);
}

function installCustomWebRtcHooks() {
    patchMethod(RTCPeerConnection?.prototype, "addTrack", original => function (
        this: RTCPeerConnection,
        track: MediaStreamTrack,
        ...streams: MediaStream[]
    ) {
        const sender = original.call(this, track, ...streams) as RTCRtpSender;
        configureCustomSender(this, sender);
        return sender;
    });

    patchMethod(RTCPeerConnection?.prototype, "addTransceiver", original => function (
        this: RTCPeerConnection,
        trackOrKind: MediaStreamTrack | string,
        init?: RTCRtpTransceiverInit
    ) {
        const transceiver = original.call(this, trackOrKind, init) as RTCRtpTransceiver;
        senderTransceivers.set(transceiver.sender, transceiver);

        if (isCustomScreenSender(transceiver.sender)) {
            applyCustomCodecPreference(transceiver);
            void applyCustomSenderParameters(transceiver.sender);
        }

        return transceiver;
    });

    patchMethod(RTCRtpSender?.prototype, "replaceTrack", original => async function (
        this: RTCRtpSender,
        withTrack: MediaStreamTrack | null
    ) {
        const result = await original.call(this, withTrack);

        if (isCustomScreenSender(this)) {
            const transceiver = senderTransceivers.get(this);
            if (transceiver) applyCustomCodecPreference(transceiver);
            void applyCustomSenderParameters(this);
        }

        return result;
    });
}

const disableStreamPreviews = getUserSettingLazy<boolean>("voiceAndVideo", "disableStreamPreviews")!;

export default definePlugin({
    name: "WebScreenShare",
    authors: [Devs.ThaUnknown],
    description: "Adds a browser screenshare picker with resolution/FPS presets and a Custom mode for advanced WebRTC codec, bitrate, scaling, priority and encoder controls.",
    tags: ["Voice", "Utility"],
    enabledByDefault: true,
    settings,
    managedStyle,

    start() {
        navigator.mediaDevices.getDisplayMedia = openScreenSharePicker;
        restoreMethodPatches();
        installCustomWebRtcHooks();
    },
    stop() {
        navigator.mediaDevices.getDisplayMedia = getDisplayMedia;
        restoreMethodPatches();
    },

    patches: [
        {
            find: "this.getDefaultGoliveQuality()",
            replacement: [
                {
                    match: /this\.getDefaultGoliveQuality\(\)/,
                    replace: "$self.getGoliveMaxQuality(        {
            find: "this.getDefaultGoliveQuality()",
            replacement: {
                match: /this\.getDefaultGoliveQuality\(\)/,
                replace: "$self.getGoliveMaxQuality($&)"
            }
        },)"
                },
                {
                    match: /setGoliveQuality\((\i)\)\{/,
                    replace: "setGoliveQuality($1){$1=$self.patchGoliveArgs($1);",
                    noWarn: true
                },
                {
                    match: /(\i)\.encodingVideoMinBitRate=\i\.bitrateMin,\i\.encodingVideoMaxBitRate=\i\.bitrateMax/,
                    replace: "        {
            find: "this.getDefaultGoliveQuality()",
            replacement: {
                match: /this\.getDefaultGoliveQuality\(\)/,
                replace: "$self.getGoliveMaxQuality($&)"
            }
        },;$self.patchEncodingVideoBitrates($1)",
                    noWarn: true
                }
            ]
        },
        {
            find: "}setDesktopEncodingOptions(",
            replacement: {
                match: /keyframeInterval=(0)/,
                replace: "keyframeInterval=$self.getKeyframeInterval($1)",
                noWarn: true
            },
            noWarn: true
        }
    ],

    getKeyframeInterval(original: number) {
        if (settings.store.contentHint !== "") return original;
        const interval = Math.max(0, Number(settings.store.customKeyframeIntervalMs ?? 0));
        return interval > 0 ? interval : original;
    },

    patchGoliveArgs(opts: any) {
        if (settings.store.contentHint !== "" || !opts) return opts;

        const bitrate = getCustomBitrates();
        return {
            ...opts,
            ...(bitrate.min > 0 ? { bitrateMin: bitrate.min } : {}),
            ...(bitrate.target > 0 ? { bitrateTarget: bitrate.target } : {}),
            ...(bitrate.max > 0 ? { bitrateMax: bitrate.max } : {})
        };
    },

    patchEncodingVideoBitrates(encoding: any) {
        if (settings.store.contentHint !== "" || !encoding) return encoding;

        const bitrate = getCustomBitrates();
        if (bitrate.min > 0) encoding.encodingVideoMinBitRate = bitrate.min;
        if (bitrate.max > 0) encoding.encodingVideoMaxBitRate = bitrate.max;
        return encoding;
    },

    getGoliveMaxQuality(opts: any) {
        const framerate = 120;
        const height = 2160;
        const width = 3840;

        if (settings.store.contentHint === "") {
            const bitrate = getCustomBitrates();
            if (bitrate.min > 0) opts.bitrateMin = bitrate.min;
            if (bitrate.target > 0) opts.bitrateTarget = bitrate.target;
            if (bitrate.max > 0) opts.bitrateMax = bitrate.max;
        }

        if (opts?.encode) {
            Object.assign(opts.encode, {
                framerate,
                width,
                height,
                pixelCount: height * width
            });
        }

        Object.assign((opts.capture ??= {}), {
            framerate,
            width,
            height,
            pixelCount: height * width
        });

        return opts;
    }
});
