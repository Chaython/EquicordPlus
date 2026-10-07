/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "WebScreenShareFixes",
    authors: [Devs.Kaitlyn],
    description: "Fixes Chromium/Vesktop screen sharing: raises Discord/WebRTC bitrate limits and prevents preview CPU growth.",
    tags: ["Voice"],
    enabledByDefault: true,

    patches: [
        {
            find: "x-google-max-bitrate",
            replacement: [
                {
                    match: /`x-google-max-bitrate=\$\{\i\}`/,
                    replace: '"x-google-max-bitrate=80000"'
                },
                {
                    match: /;usedtx=\$\{(\i)\?"0":"1"\}/,
                    replace: '$&${$1?";stereo=1;sprop-stereo=1":""}'
                },
            ]
        },
        {
            // Discord Web's setDesktopEncodingOptions() writes its calculated
            // bitrate cap into both the Go Live quality manager and the stream
            // parameters later sent as OP 12 max_bitrate. Raise both without
            // touching codec negotiation or RTCRtpSender methods.
            find: "lastDesktopEncodingOptions",
            replacement: [
                {
                    match: /\.setGoliveQuality\(\{capture:(\i),encode:(\i),bitrateMax:\i\}\)/,
                    replace: ".setGoliveQuality({capture:$1,encode:$2,bitrateMin:5e5,bitrateMax:8e7,bitrateTarget:2e7})"
                },
                {
                    match: /(\.videoStreamParameters\[\i\]\.maxBitrate)=\i/,
                    replace: "$1=8e7"
                }
            ]
        },
        {
            find: "ApplicationStreamPreviewUploadManager",
            replacement: {
                match: /removeAttribute\("srcObject"\)(?<=(\i)\..+?)/,
                replace: "pause(),$1.srcObject=null"
            }
        }
    ]
});
