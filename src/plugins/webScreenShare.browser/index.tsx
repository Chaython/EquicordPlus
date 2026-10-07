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

            // const conn = [...MediaEngineStore.getMediaEngine().connections].find(
            //     connection => connection.userId === UserStore.getCurrentUser().id
            // );

            const videoOptions = typeof options?.video !== "boolean" && !!options.video ? options.video : {};
            const audioOptions = typeof options?.audio !== "boolean" && !!options.audio ? options.audio : {};
            // allow browser to constrain itself
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
                }).then(t => {
                    // w3c says this can fail, they don't say why, so just to be safe
                    try {
                        const video = t.getVideoTracks()?.[0];
                        if (video) video.contentHint = liveSettings.contentHint;
                    } catch { }
                    return t;
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
                            <span>{liveSettings.contentHint === "motion" ? "Smoother video" : liveSettings.contentHint === "detail" ? "Cleaner text" : "User preset"}</span>
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
                ]}
            >

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
                        <div>
                            <OptionRadio
                                options={StreamContentHint}
                                labels={["Smoother video", "Cleaner text", "Custom"]}
                                settings={liveSettings}
                                settingsKey="contentHint"
                                onChange={option => (liveSettings.contentHint = option)}
                            />
                        </div>
                    </div>
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

// this is kinda shit and it really should be done via videoQualityManager
const StreamResolution = ["480", "720", "1080", "1440", "2160"] as const;
const StreamFps = ["15", "30", "60", "120"] as const;
const StreamContentHint = ["motion", "detail", ""] as const;

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
    }
});

const disableStreamPreviews = getUserSettingLazy<boolean>("voiceAndVideo", "disableStreamPreviews")!;

export default definePlugin({
    name: "WebScreenShare",
    authors: [Devs.ThaUnknown],
    description: "Adds a screenshare options menu. Allows for changing resolution, framerate, encoding hints, and system audio settings.",
    tags: ["Voice", "Utility"],
    enabledByDefault: true,
    settings,
    managedStyle,

    start() {
        navigator.mediaDevices.getDisplayMedia = openScreenSharePicker;
    },
    stop() {
        navigator.mediaDevices.getDisplayMedia = getDisplayMedia;
    },

    patches: [
        {
            // Patch Discord Web's Go Live default profile directly. The old
            // call-site wrapper around this.getDefaultGoliveQuality() became
            // unreliable across minified bundle changes and could fall back
            // to the stock 720p30 / 2.5 Mbps profile after a full restart.
            find: "getDefaultGoliveQuality(){",
            replacement: {
                match: /getDefaultGoliveQuality\(\)\{return new (\i)\(\{capture:\{width:1280,height:720,framerate:([^}]+)\},encode:\{width:1280,height:720,framerate:\2,pixelCount:921600\},bitrateMin:this\.options\.desktopBitrate\.min,bitrateMax:this\.options\.desktopBitrate\.max,bitrateTarget:this\.options\.desktopBitrate\.target\}\)\}/,
                replace: "getDefaultGoliveQuality(){return new $1({capture:{width:3840,height:2160,framerate:120},encode:{width:3840,height:2160,framerate:120,pixelCount:8294400},bitrateMin:5e5,bitrateMax:8e7,bitrateTarget:2e7})}"
            }
        }
    ],
    // this is a maximum, not a true default, this is later constrained properly in GDM anyways
    // and this way we don't pre-emptively neuter the max stream quality
    getGoliveMaxQuality(opts: any) {
        const framerate = 120;
        const height = 2160;
        const width = 3840;

        Object.assign(opts, {
            // Allow WebRTC to back off when needed, but start from a useful
            // high-quality target instead of Discord Web's sub-megabit default.
            bitrateMin: 500000,
            bitrateMax: 80000000,
            bitrateTarget: 20000000
        });
        if (opts?.encode) {
            Object.assign(opts.encode, {
                framerate,
                width,
                height,
                pixelCount: height * width
            });
        }
        Object.assign(opts.capture, {
            framerate,
            width,
            height,
            pixelCount: height * width
        });
        return opts;
    }
});
