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

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import { Flex } from "@components/Flex";
import { Devs, EquicordDevs } from "@utils/constants";
import { getIntlMessage } from "@utils/discord";
import { Margins } from "@utils/margins";
import definePlugin, { OptionType } from "@utils/types";
import { findByCodeLazy, findLazy } from "@webpack";
import { Card, ChannelStore, Forms, GuildMemberStore, GuildStore, PermissionsBits, Switch, TextInput, Tooltip } from "@webpack/common";
import type { Permissions, RC } from "@webpack/types";
import type { Channel, Guild, Message, User } from "discord-types/general";

interface Tag {
    // name used for identifying, must be alphanumeric + underscores
    name: string;
    // name shown on the tag itself, can be anything probably; automatically uppercase'd
    displayName: string;
    description: string;
    permissions?: Permissions[];
    condition?(message: Message | null, user: User, channel: Channel): boolean;
}

interface TagSetting {
    text: string;
    showInChat: boolean;
    showInNotChat: boolean;
}
interface TagSettings {
    WEBHOOK: TagSetting,
    OWNER: TagSetting,
    ADMINISTRATOR: TagSetting,
    MODERATOR_STAFF: TagSetting,
    MODERATOR: TagSetting,
    VOICE_MODERATOR: TagSetting,
    TRIAL_MODERATOR: TagSetting,
    [k: string]: TagSetting;
}

// PermissionStore.computePermissions will not work here since it only gets permissions for the current user
const computePermissions: (options: {
    user?: { id: string; } | string | null;
    context?: Guild | Channel | null;
    overwrites?: Channel["permissionOverwrites"] | null;
    checkElevated?: boolean /* = true */;
    excludeGuildPermissions?: boolean /* = false */;
}) => bigint = findByCodeLazy(".getCurrentUser()", ".computeLurkerPermissionsAllowList()");

const Tag = findLazy(m => m.Types?.[0] === "BOT") as RC<{ type?: number, className?: string, useRemSizes?: boolean; }> & { Types: Record<string, number>; };

const isWebhook = (message: Message, user: User) => !!message?.webhookId && user.isNonUserBot();

const tags: Tag[] = [
    {
        name: "WEBHOOK",
        displayName: "Webhook",
        description: "Messages sent by webhooks",
        condition: isWebhook
    }, {
        name: "OWNER",
        displayName: "Owner",
        description: "Owns the server",
        condition: (_, user, channel) => GuildStore.getGuild(channel?.guild_id)?.ownerId === user.id
    }, {
        name: "ADMINISTRATOR",
        displayName: "Admin",
        description: "Has the administrator permission",
        permissions: ["ADMINISTRATOR"]
    }, {
        name: "MODERATOR_STAFF",
        displayName: "Staff",
        description: "Can manage the server, channels or roles",
        permissions: ["MANAGE_GUILD", "MANAGE_CHANNELS", "MANAGE_ROLES"]
    }, {
        name: "MODERATOR",
        displayName: "Mod",
        description: "Can manage messages or kick/ban people",
        permissions: ["MANAGE_MESSAGES", "KICK_MEMBERS", "BAN_MEMBERS"]
    }, {
        name: "VOICE_MODERATOR",
        displayName: "VC Mod",
        description: "Can manage voice chats",
        permissions: ["MOVE_MEMBERS", "MUTE_MEMBERS", "DEAFEN_MEMBERS"]
    }, {
        name: "CHAT_MODERATOR",
        displayName: "Chat Mod",
        description: "Can timeout people",
        permissions: ["MODERATE_MEMBERS"]
    }
];
const defaultSettings = Object.fromEntries(
    tags.map(({ name, displayName }) => [name, { text: displayName, showInChat: true, showInNotChat: true }])
) as TagSettings;

// From https://gist.github.com/StevenBlack/960189
export function getContrastYIQ(hexColor: string | undefined): "#000" | "#fff" | undefined {
    if (!hexColor) return;
    const r = parseInt(hexColor.substring(1, 3), 16);
    const g = parseInt(hexColor.substring(3, 5), 16);
    const b = parseInt(hexColor.substring(5, 7), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 128 ? "#000" : "#fff";
}

function SettingsComponent() {
    const tagSettings = settings.store.tagSettings ??= defaultSettings;

    return (
        <Flex flexDirection="column">
            {tags.map(t => (
                <Card key={t.name} style={{ padding: "1em 1em 0" }}>
                    <Forms.FormTitle style={{ width: "fit-content" }}>
                        <Tooltip text={t.description}>
                            {({ onMouseEnter, onMouseLeave }) => (
                                <div
                                    onMouseEnter={onMouseEnter}
                                    onMouseLeave={onMouseLeave}
                                >
                                    {t.displayName} Tag <Tag type={Tag.Types[t.name]} />
                                </div>
                            )}
                        </Tooltip>
                    </Forms.FormTitle>

                    <TextInput
                        type="text"
                        value={tagSettings[t.name]?.text ?? t.displayName}
                        placeholder={`Text on tag (default: ${t.displayName})`}
                        onChange={v => tagSettings[t.name].text = v}
                        className={Margins.bottom16}
                    />

                    <Switch
                        value={tagSettings[t.name]?.showInChat ?? true}
                        onChange={v => tagSettings[t.name].showInChat = v}
                        hideBorder
                    >
                        Show in messages
                    </Switch>

                    <Switch
                        value={tagSettings[t.name]?.showInNotChat ?? true}
                        onChange={v => tagSettings[t.name].showInNotChat = v}
                        hideBorder
                    >
                        Show in member list and profiles
                    </Switch>
                </Card>
            ))}
        </Flex>
    );
}

const settings = definePluginSettings({
    dontShowForBots: {
        description: "Don't show extra tags for bots (excluding webhooks)",
        type: OptionType.BOOLEAN
    },
    dontShowBotTag: {
        description: "Only show extra tags for bots / Hide [BOT] text",
        type: OptionType.BOOLEAN
    },
    useRoleColors: {
        description: "Use the user's role color instead of the default color",
        type: OptionType.BOOLEAN
    },
    tagSettings: {
        type: OptionType.COMPONENT,
        component: SettingsComponent,
        description: "fill me"
    }
});

export default definePlugin({
    name: "MoreUserTags",
    description: "Adds tags for webhooks and moderative roles (owner, admin, etc.)",
    authors: [Devs.Cyn, Devs.TheSun, Devs.RyanCaoDev, Devs.LordElias, Devs.AutumnVN, EquicordDevs.OIRNOIR],
    settings,
    patches: [
        // add tags to the tag list
        {
            find: ".ORIGINAL_POSTER=",
            replacement: {
                match: /(?=(\i)\[\i\.BOT)/,
                replace: "$self.genTagTypes($1);"
            }
        },
        {
            find: "#{intl::DISCORD_SYSTEM_MESSAGE_BOT_TAG_TOOLTIP_OFFICIAL}",
            replacement: [
                // Grab the colors from the params using the custom params
                {
                    match: /type:\i=\i\.\i\.BOT/,
                    replace: "$&,moreTags_bgColor:moreTags_bgColor,moreTags_fgColor:moreTags_fgColor"
                },
                // make the tag show the right text
                {
                    match: /(switch\((\i)\){.+?)case (\i(?:\.\i)?)\.BOT:default:(\i)=(.{0,40}#{intl::APP_TAG}\))/,
                    replace: (_, origSwitch, variant, tags, displayedText, originalText) =>
                        `${origSwitch}default:{${displayedText} = $self.getTagText(${tags}[${variant}],${originalText})}`
                },
                // show OP tags correctly
                {
                    match: /(\i)=(\i)===\i(?:\.\i)?\.ORIGINAL_POSTER/,
                    replace: "$1=$self.isOPTag($2)"
                },
                // add HTML data attributes (for easier theming)
                // also set the colors
                {
                    match: /.botText,children:(\i)}\)]/,
                    replace: "$&,'data-tag':$1.toLowerCase(),style:{'background-color':moreTags_bgColor,'color':moreTags_fgColor},'data-moreTags-darkFg':moreTags_fgColor?.includes('0')"
                }
            ],
        },
        // in messages
        {
            find: ".Types.ORIGINAL_POSTER",
            replacement: [
                // Pass the tag's colors and type to the next function
                {
                    match: /;return\((\(null==\i\?void 0:\i\.isSystemDM\(\).+?.Types.ORIGINAL_POSTER\)),null==(\i)\)\?null:\(0,(\i)\.jsx\)\((\i).(\i),{/,
                    replace: ";$1;$2=$self.getTag({...arguments[0],origType:$2,location:'chat'});return $2 == null?null:(0,$3.jsx)($4.$5,{...$self.getTagColors({...arguments[0],tagType:$2,location:'chat'}),"
                }
            ]
        },
        // in the member list
        {
            find: "#{intl::GUILD_OWNER}),children:",
            replacement: [
                // Pass the tag's colors and type to the next function
                {
                    match: /(?<type>\i)=\(null==.{0,100}\.BOT;return null!=(?<user>\i)&&\i\.bot\?\(0,(?<jsxf>\i)\.jsx\)\((?<module>\i)\.(?<subm>\i),{/,
                    replace: "$<type> = $self.getTag({user: $<user>, channel: arguments[0].channel, origType: $<user>.bot ? 0 : null, location: 'not-chat' }); return typeof $<type> === 'number'?(0,$<jsxf>.jsx)($<module>.$<subm>,{...$self.getTagColors({...arguments[0],tagType:$<type>,location:'not-chat'}),"
                }
            ]
        },
        // pass channel id down props to be used in profiles
        {
            find: ".hasAvatarForGuild(null==",
            replacement: {
                match: /(?=usernameIcon:)/,
                replace: "moreTags_channelId:arguments[0].channelId,"
            }
        },
        {
            find: "#{intl::USER_PROFILE_PRONOUNS}",
            replacement: {
                match: /(?=,hideBotTag:!0)/,
                replace: ",moreTags_channelId:arguments[0].moreTags_channelId"
            }
        },
        // in profiles
        {
            find: ",overrideDiscriminator:",
            group: true,
            replacement: [
                {
                    // prevent channel id from getting ghosted
                    // it's either this or extremely long lookbehind
                    match: /user:\i,nick:\i,/,
                    replace: "$&moreTags_channelId,"
                },
                {
                    // Get the tag type and tag colors so that they can be distributed
                    match: /(,\i=\i\.isPomelo\(\)\|\|\i;)(.+?botType:(\i),botVerified:(\i),(?!discriminatorClass:)(?<=user:(\i).+?))/,
                    replace: "$1let moreTags_tagType=$self.getTag({user:$5,channelId:moreTags_channelId,origType:$3,location:'not-chat'});let moreTags_tagColors=$self.getTagColors({user:$5,channelId:moreTags_channelId,tagType:moreTags_tagType,location:'not-chat'});$2"
                },
                {
                    match: /,botType:(\i),botVerified:(\i),(?!discriminatorClass:)(?<=user:(\i).+?)/g,
                    replace: ",botType:moreTags_tagType,...moreTags_tagColors,"
                }, {
                    // Get the parameters from the function that were passed in previously
                    // because Discord needs to make it hard on us
                    match: /,botClass:\i,showStreamerModeTooltip:\i/,
                    replace: "$&,moreTags_bgColor:moreTags_bgColor,moreTags_fgColor:moreTags_fgColor"
                }, {
                    // Finally pass the color information into the renderer
                    match: /\.jsx\)\(\i\.\i,{type:\i,/,
                    replace: "$&moreTags_bgColor,moreTags_fgColor,"
                }
            ]
        },
        // Colors need to be passed down through this random module.
        // If there's a way to bypass this module without modifying discord's random variables (We don't want to break stuff) leave a PR (or comment if an existing one is open)
        {
            find: ",invertBotTagColor:",
            replacement: [
                {
                    match: /,invertBotTagColor:\i/,
                    replace: "$&,moreTags_bgColor:moreTags_bgColor,moreTags_fgColor:moreTags_fgColor"
                }, {
                    match: /verified:\i,useRemSizes:\i/,
                    replace: "$&,moreTags_bgColor,moreTags_fgColor"
                }
            ]
        }
    ],

    start() {
        settings.store.tagSettings ??= defaultSettings;

        // newly added field might be missing from old users
        settings.store.tagSettings.CHAT_MODERATOR ??= {
            text: "Chat Mod",
            showInChat: true,
            showInNotChat: true
        };
    },

    getPermissions(user: User, channel: Channel): string[] {
        const guild = GuildStore.getGuild(channel?.guild_id);
        if (!guild) return [];

        const permissions = computePermissions({ user, context: guild, overwrites: channel.permissionOverwrites });
        return Object.entries(PermissionsBits)
            .map(([perm, permInt]) =>
                permissions & permInt ? perm : ""
            )
            .filter(Boolean);
    },

    genTagTypes(obj) {
        let i = 100;
        tags.forEach(({ name }) => {
            obj[name] = ++i;
            obj[i] = name;
            obj[`${name}-BOT`] = ++i;
            obj[i] = `${name}-BOT`;
            obj[`${name}-OP`] = ++i;
            obj[i] = `${name}-OP`;
        });
    },

    isOPTag: (tag: number) => tag === Tag.Types.ORIGINAL_POSTER || tags.some(t => tag === Tag.Types[`${t.name}-OP`]),

    getTagText(passedTagName: string, originalText: string) {
        try {
            const [tagName, variant] = passedTagName.split("-");
            if (!passedTagName) return getIntlMessage("APP_TAG");
            const tag = tags.find(({ name }) => tagName === name);
            if (!tag) return getIntlMessage("APP_TAG");
            if (variant === "BOT" && tagName !== "WEBHOOK" && this.settings.store.dontShowForBots) return getIntlMessage("APP_TAG");

            const tagText = settings.store.tagSettings?.[tag.name]?.text || tag.displayName;
            switch (variant) {
                case "OP":
                    return `${getIntlMessage("BOT_TAG_FORUM_ORIGINAL_POSTER")} • ${tagText}`;
                case "BOT":
                    return `${getIntlMessage("APP_TAG")} • ${tagText}`;
                default:
                    return tagText;
            }
        } catch {
            return originalText;
        }
    },


    getTagColors({
        user, channelId, channel, location, tagType
    }: {
        user: User,
        channel?: Channel,
        channelId?: string;
        location: "chat" | "not-chat";
        tagType: number;
    }): {
        moreTags_bgColor: string,
        moreTags_fgColor: string;
    } {
        const passedTagName = Object.keys(Tag.Types).find(k => Tag.Types[k] === tagType);
        const [tagName, variant] = passedTagName?.split("-") ?? [null, null];
        if (!settings.store.useRoleColors || !tagType || !tagName || (location === "chat" && !settings.store.tagSettings[tagName]?.showInChat) || (location === "not-chat" && !settings.store.tagSettings[tagName]?.showInNotChat) || (user.bot && settings.store.dontShowForBots)) {
            return { moreTags_bgColor: "", moreTags_fgColor: "" };
        }
        if (!channel && channelId) channel = ChannelStore.getChannel(channelId);
        const member = channel?.guild_id != null ? GuildMemberStore.getMember(channel?.guild_id, user.id) : null;
        const colorString = member?.colorString;
        const fgColorString = colorString != null ? getContrastYIQ(colorString) : null;
        return { moreTags_bgColor: colorString ?? "", moreTags_fgColor: fgColorString ?? "" };
    },

    getTag({
        message, user, channelId, origType, location, channel
    }: {
        message?: Message,
        user: User & { isClyde(): boolean; },
        channel?: Channel & { isForumPost(): boolean; isMediaPost(): boolean; },
        channelId?: string;
        origType?: number;
        location: "chat" | "not-chat";
    }): number | null {
        if (!user)
            return null;
        if (location === "chat" && user.id === "1")
            return Tag.Types.OFFICIAL;
        if (user.isClyde())
            return Tag.Types.AI;

        let type = typeof origType === "number" ? origType : null;

        channel ??= ChannelStore.getChannel(channelId!) as any;
        if (!channel) return type;

        const settings = this.settings.store;
        const perms = this.getPermissions(user, channel);

        for (const tag of tags) {
            if (location === "chat" && !settings.tagSettings[tag.name]?.showInChat) continue;
            if (location === "not-chat" && !settings.tagSettings[tag.name]?.showInNotChat) continue;

            // If the owner tag is disabled, and the user is the owner of the guild,
            // avoid adding other tags because the owner will always match the condition for them
            if (
                tag.name !== "OWNER" &&
                GuildStore.getGuild(channel?.guild_id)?.ownerId === user.id &&
                (location === "chat" && !settings.tagSettings.OWNER.showInChat) ||
                (location === "not-chat" && !settings.tagSettings.OWNER.showInNotChat)
            ) continue;

            if (
                tag.permissions?.some(perm => perms.includes(perm)) ||
                (tag.condition?.(message!, user, channel))
            ) {
                if ((channel.isForumPost() || channel.isMediaPost()) && channel.ownerId === user.id)
                    type = Tag.Types[`${tag.name}-OP`];
                else if (user.bot && !isWebhook(message!, user) && !settings.dontShowBotTag)
                    type = Tag.Types[`${tag.name}-BOT`];
                else
                    type = Tag.Types[tag.name];
                break;
            }
        }
        return type;
    }
});
