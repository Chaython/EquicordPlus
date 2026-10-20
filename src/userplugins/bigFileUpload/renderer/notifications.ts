/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { Settings } from "@api/Settings";
import { showToast } from "@webpack/common";

/**
 * Show upload notification or toast based on user preference
 * Consolidated from index.tsx and UploadProgressBar.tsx to avoid duplication
 */
type ToastVariant = "default" | "success" | "critical";

export function showUploadNotification(message: string, type: ToastVariant = "default") {
    const useNotifications = Settings.plugins.BigFileUpload?.useNotifications === "Yes";

    if (useNotifications) {
        const color = type === "critical"
            ? "var(--red-360)"
            : type === "success"
                ? "var(--green-360)"
                : undefined;

        showNotification({
            title: "BigFileUpload",
            body: message,
            color,
            noPersist: true
        });
    } else {
        showToast({ text: message, variant: type });
    }
}
