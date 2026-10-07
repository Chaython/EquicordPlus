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
            // setDesktopEncodingOptions() calculates one max-bitrate value and
            // then reuses it for both the WebRTC quality constraints and the
            // OP 12 stream max_bitrate advertised to Discord's RTC server.
            // Override that single value so the two layers stay in sync.
            find: "lastDesktopEncodingOptions",
            replacement: {
                match: /(let (\i)=this\.calcMaxBitrateFunc\(\{width:\i,height:\i,framerate:\i,videoCodec:this\.currentVideoCodec\}\);)null==\2&&\(\2=[^;]+?\);/,
                replace: "$1$2=8e7;"
            }
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
