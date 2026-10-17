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
    description: "Fixes Chromium/Vesktop screen sharing: restores 10 Mbps video startup bandwidth, raises Go Live bitrate limits, and prevents preview CPU growth.",
    tags: ["Voice"],
    enabledByDefault: true,

    patches: [
        {
            find: "x-google-max-bitrate",
            replacement: [
                {
                    match: /`x-google-max-bitrate=\$\{\i\}`/,
                    // Restore the previous 10 Mbps startup bitrate while retaining
                    // the existing adaptive WebRTC estimator and Go Live limits.
                    replace: '"x-google-min-bitrate=1000;x-google-start-bitrate=10000;x-google-max-bitrate=80000"'
                },
                {
                    match: /;usedtx=\$\{(\i)\?"0":"1"\}/,
                    replace: '$&${$1?";stereo=1;sprop-stereo=1":""}'
                },
            ]
        },
        {
            // Keep the existing Go Live quality-specific bitrate limits.
            find: "\"remoteSinkWantsPixelCount\"",
            replacement: [
                {
                    match: /(\i)=35e5,(\i)=9e6,(?=\i=\["remoteSinkWantsPixelCount")/,
                    replace: "$1=35e5,$2=8e7,"
                },
                {
                    match: /desktopBitrate:\{min:5e5,max:35e5,target:6e5\}/,
                    replace: "desktopBitrate:{min:5e5,max:8e7,target:2e7}"
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
