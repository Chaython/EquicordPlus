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
    description: "Fixes Chromium/Vesktop screen sharing: raises the SDP bitrate ceiling, exposes AV1 to Discord's RTC codec negotiation, and prevents preview CPU growth.",
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
                {
                    // Discord Web parses Chromium's video SDP into the RTC codec list
                    // using H264/VP8/VP9 (plus H265 behind BROWSER_HEVC), dropping AV1
                    // before OP 1 SELECT_PROTOCOL. Add AV1 first while preserving fallbacks.
                    match: /(\i)\?\[(\i)\.UK\.H265,\i\.UK\.H264,\i\.UK\.VP8,\i\.UK\.VP9\]:\[\i\.UK\.H264,\i\.UK\.VP8,\i\.UK\.VP9\]/,
                    replace: '$1?["AV1",$2.UK.H265,$2.UK.H264,$2.UK.VP8,$2.UK.VP9]:["AV1",$2.UK.H264,$2.UK.VP8,$2.UK.VP9]'
                },
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
