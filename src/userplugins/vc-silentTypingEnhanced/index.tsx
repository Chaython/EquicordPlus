/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { addChatBarButton, ChatBarButton, removeChatBarButton } from "@api/ChatButtons";
import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, FluxDispatcher, React } from "@webpack/common";

const settings = definePluginSettings({
    showIcon: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show an icon for toggling the plugin",
        restartNeeded: true,
    },
    isEnabled: {
        type: OptionType.BOOLEAN,
        description: "Toggle functionality",
        default: true,
    },
    specificChats: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Disable silent typing for specific chats instead (use icon to toggle)",
        restartNeeded: false,
    },
    disabledFor: {
        type: OptionType.STRING,
        description: "Disable functionality for these chats (comma separated list of guild or user IDs)",
        default: "",
    },
});

const SilentTypingToggle: ChatBarButton = ({ isMainChat, channel }) => {
    const { isEnabled, showIcon, specificChats, disabledFor } = settings.use(["isEnabled", "showIcon", "specificChats", "disabledFor"]);
    const id = channel.guild_id ?? channel.id;

    const toggleGlobal = () => {
        settings.store.isEnabled = !settings.store.isEnabled;
    };
    const toggle = () => {
        if (specificChats) {
            if (!settings.store.isEnabled) {
                toggleGlobal();
            } else {
                const disabledChannels = getDisabledChannelsList(disabledFor);
                if (disabledChannels.includes(id)) {
                    disabledChannels.splice(disabledChannels.indexOf(id), 1);
                } else {
                    disabledChannels.push(id);
                }
                settings.store.disabledFor = disabledChannels.join(", ");
            }
        } else {
            toggleGlobal();
        }
    };
    const shouldEnable = isEnabled && (!specificChats || !getDisabledChannelsList(disabledFor).includes(id));

    let tooltip = shouldEnable ? "Disable Silent Typing" : "Enable Silent Typing";
    if (specificChats) {
        if (!isEnabled) {
            tooltip = "Re-enable Silent Typing globally";
        } else {
            const chatType = channel.guild_id ? "guild" : "user";
            tooltip = shouldEnable ? `Disable Silent Typing for current ${chatType} (right-click to toggle globally)`
                : `Enable Silent Typing for current ${chatType} (right-click to toggle globally)`;
        }
    }

    if (!isMainChat || !showIcon) return null;

    return (
        <ChatBarButton
            tooltip={tooltip}
            onClick={toggle}
            onContextMenu={toggleGlobal}
        >
            <svg width="24" height="24" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512">
                <path fill="currentColor"
                    d="M528 448H48c-26.51 0-48-21.49-48-48V112c0-26.51 21.49-48 48-48h480c26.51 0 48 21.49 48 48v288c0 26.51-21.49 48-48 48zM128 180v-40c0-6.627-5.373-12-12-12H76c-6.627 0-12 5.373-12 12v40c0 6.627 5.373 12 12 12h40c6.627 0 12-5.373 12-12zm96 0v-40c0-6.627-5.373-12-12-12h-40c-6.627 0-12 5.373-12 12v40c0 6.627 5.373 12 12 12h40c6.627 0 12-5.373 12-12zm96 0v-40c0-6.627-5.373-12-12-12h-40c-6.627 0-12 5.373-12 12v40c0 6.627 5.373 12 12 12h40c6.627 0 12-5.373 12-12zm96 0v-40c0-6.627-5.373-12-12-12h-40c-6.627 0-12 5.373-12 12v40c0 6.627 5.373 12 12 12h40c6.627 0 12-5.373 12-12zm96 0v-40c0-6.627-5.373-12-12-12h-40c-6.627 0-12 5.373-12 12v40c0 6.627 5.373 12 12 12h40c6.627 0 12-5.373 12-12zm-336 96v-40c0-6.627-5.373-12-12-12h-40c-6.627 0-12 5.373-12 12v40c0 6.627 5.373 12 12 12h40c6.627 0 12-5.373 12-12zm96 0v-40c0-6.627-5.373-12-12-12h-40c-6.627 0-12 5.373-12 12v40c0 6.627 5.373 12 12 12h40c6.627 0 12-5.373 12-12zm96 0v-40c0-6.627-5.373-12-12-12h-40c-6.627 0-12 5.373-12 12v40c0 6.627 5.373 12 12 12h40c6.627 0 12-5.373 12-12zm96 0v-40c0-6.627-5.373-12-12-12h-40c-6.627 0-12 5.373-12 12v40c0 6.627 5.373 12 12 12h40c6.627 0 12-5.373 12-12zm-336 96v-40c0-6.627-5.373-12-12-12H76c-6.627 0-12 5.373-12 12v40c0 6.627 5.373 12 12 12h40c6.627 0 12-5.373 12-12zm288 0v-40c0-6.627-5.373-12-12-12H172c-6.627 0-12 5.373-12 12v40c0 6.627 5.373 12 12 12h232c6.627 0 12-5.373 12-12zm96 0v-40c0-6.627-5.373-12-12-12h-40c-6.627 0-12 5.373-12 12v40c0 6.627 5.373 12 12 12h40c6.627 0 12-5.373 12-12z" />
                {shouldEnable &&
                    <path d="M13 432L590 48" stroke="var(--red-500)" strokeWidth="72" strokeLinecap="round" />}
                {specificChats && !settings.store.isEnabled &&
                    <path
                        transform="matrix(0.27724514,0,0,0.27724514,34.252062,-35.543268)"
                        d="M 1827.701,303.065 698.835,1431.801 92.299,825.266 0,917.564 698.835,1616.4 1919.869,395.234 Z"
                        stroke="var(--green-500)"
                        strokeWidth="150" strokeLinecap="round"
                        fillRule="evenodd" />
                }
            </svg>
        </ChatBarButton>
    );
};

function getDisabledChannelsList(list = settings.store.disabledFor) {
    try {
        return list.split(",").map(x => x.trim()).filter(Boolean);
    } catch (e) {
        settings.store.disabledFor = "";
        return [];
    }
}

function isEnabled(channelId: string) {
    if (!settings.store.isEnabled) return false;
    if (settings.store.specificChats) {
        // need to resolve guild id for guild channels
        const guildId = ChannelStore.getChannel(channelId)?.guild_id;
        return !getDisabledChannelsList().includes(guildId ?? channelId);
    }
    return true;
}

export default definePlugin({
    name: "SilentTyping",
    authors: [Devs.Ven, Devs.Rini, Devs.D3SOX],
    description: "Hide that you are typing",
    dependencies: ["ChatInputButtonAPI"],
    settings,

    patches: [
        {
            find: '.dispatch({type:"TYPING_START_LOCAL"',
            replacement: {
                match: /startTyping\(\i\){.+?},stop/,
                replace: "startTyping:$self.startTyping,stop"
            }
        },
    ],

    commands: [{
        name: "silenttype",
        description: "Toggle whether you're hiding that you're typing or not.",
        inputType: ApplicationCommandInputType.BUILT_IN,
        options: [
            {
                name: "value",
                description: "whether to hide or not that you're typing (default is toggle)",
                required: false,
                type: ApplicationCommandOptionType.BOOLEAN,
            },
        ],
        execute: async (args, ctx) => {
            settings.store.isEnabled = !!findOption(args, "value", !settings.store.isEnabled);
            sendBotMessage(ctx.channel.id, {
                content: settings.store.isEnabled ? "Silent typing enabled!" : "Silent typing disabled!",
            });
        },
    }],

    async startTyping(channelId: string) {
        if (isEnabled(channelId)) return;
        FluxDispatcher.dispatch({ type: "TYPING_START_LOCAL", channelId });
    },

    start: () => addChatBarButton("SilentTyping", SilentTypingToggle),
    stop: () => removeChatBarButton("SilentTyping"),
});
