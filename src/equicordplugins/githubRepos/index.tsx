/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { User } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { React, Text } from "@webpack/common";

import { GitHubReposComponent } from "./components/GitHubReposComponent";

export const settings = definePluginSettings({
    showStars: {
        type: OptionType.BOOLEAN,
        description: "Show repository stars",
        default: true
    },
    showLanguage: {
        type: OptionType.BOOLEAN,
        description: "Show repository language",
        default: true
    },
    showInMiniProfile: {
        type: OptionType.BOOLEAN,
        description: "Show full ui in the mini profile instead of just a button",
        default: true
    },
});


const getProfileThemeProps = findByCodeLazy(".getPreviewThemeColors", "primaryColor:");

const logger = new Logger("GitHubRepos");
logger.info("Plugin loaded");

const ProfilePopoutComponent = ErrorBoundary.wrap(
    (props: { user: User; displayProfile?: any; }) => {
        return (
            <GitHubReposComponent
                {...props}
                id={props.user.id}
                theme={getProfileThemeProps(props).theme}
            />
        );
    },
    {
        noop: true,
        onError: err => {
            logger.error("Error in profile popout component", err);
            return <Text variant="text-xs/semibold" className="vc-github-repos-error" style={{ color: "var(--text-danger)" }}>
                Error, Failed to render GithubRepos</Text>;
        }
    }
);

export default definePlugin({
    name: "GitHubRepos",
    description: "Displays a user's public GitHub repositories in their profile",
    authors: [EquicordDevs.talhakf, EquicordDevs.Panniku],
    settings,

    patches: [
        {
            find: ".hasAvatarForGuild(null==",
            replacement: {
                match: /(?<=user:(\i),bio:null==(\i)\?.+?currentUser:\i,guild:\i}\))/,
                replace: ",$self.ProfilePopoutComponent({ user: $1, displayProfile: $2 })"
            }
        },
        {
            find: "appsConnections,applicationRoleConnection",
            replacement: {
                match: /(?<=user:(\i).{0,15}displayProfile:(\i).*?application\.id\)\)\}\))/,
                replace: ",$self.ProfilePopoutComponent({ user: $1, displayProfile: $2 })"
            }
        }
    ],
    ProfilePopoutComponent
});
