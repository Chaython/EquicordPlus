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
    description: "Fixes Chromium/Vesktop screen sharing: raises Discord/WebRTC bitrate limits, seeds bandwidth probing/padding, and prevents preview CPU growth.",
    tags: ["Voice"],
    enabledByDefault: true,

    patches: [
        {
            find: "x-google-max-bitrate",
            replacement: [
                {
                    match: /`x-google-max-bitrate=\$\{\i\}`/,
                    // Chromium's WebRTC BWE starts conservatively. A non-zero
                    // min bitrate enables RTP padding, while start bitrate seeds
                    // the initial probing rate so the estimator can discover
                    // available capacity instead of idling near ~300 kbps.
                    replace: '"x-google-min-bitrate=1000;x-google-start-bitrate=10000;x-google-max-bitrate=80000"'
                },
                {
                    match: /;usedtx=\$\{(\i)\?"0":"1"\}/,
                    replace: '$&${$1?";stereo=1;sprop-stereo=1":""}'
                },
            ]
        },
        {
            // Discord Web's stable media constants include a 9 Mbps high-quality
            // Go Live ceiling and a 0.6/3.5 Mbps desktop target/max profile.
            // Patch those constants directly so both setDesktopEncodingOptions()
            // and OP 12 stream signalling inherit the higher values.
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
