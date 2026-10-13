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
    description: "Fixes Chromium/Vesktop screen sharing: raises Go Live bitrate limits without forcing webcam SDP bandwidth, and prevents preview CPU growth.",
    tags: ["Voice"],
    enabledByDefault: true,

    patches: [
        {
            find: "x-google-max-bitrate",
            replacement: [
                // Do not override Discord's generic video SDP bitrate parameters.
                // This code also applies to webcams, where a forced 1 Mbps floor
                // and 10 Mbps startup rate can interfere with camera activation
                // and renegotiation. Go Live bitrate is adjusted below instead.
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
