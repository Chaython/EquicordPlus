# EquicordPlus

[![Build](https://github.com/Chaython/EquicordPlus/actions/workflows/sync-upstream-release.yml/badge.svg?branch=main)](https://github.com/Chaython/EquicordPlus/actions/workflows/sync-upstream-release.yml)
[![Releases](https://img.shields.io/github/v/release/Chaython/EquicordPlus?include_prereleases&label=release)](https://github.com/Chaython/EquicordPlus/releases)
[![License](https://img.shields.io/github/license/Chaython/EquicordPlus)](LICENSE)

**EquicordPlus** is an extended fork of [Equicord](https://github.com/Equicord/Equicord) maintained at **[Chaython/EquicordPlus](https://github.com/Chaython/EquicordPlus)**.

It keeps Equicord's existing plugin ecosystem while adding extra bundled user plugins, custom behavior, and automated upstream syncing/builds. The fork periodically pulls compatible changes from `Equicord/Equicord:main` while retaining EquicordPlus-specific files and additions.

## Downloads

Automated EquicordPlus builds are published on the repository's **[Releases page](https://github.com/Chaython/EquicordPlus/releases)**.

The release workflow builds desktop and web/extension artifacts from this fork. TypeScript and lint diagnostics are also reported by CI.

## EquicordPlus extras

EquicordPlus currently includes the following extra user plugins under [`src/userplugins`](src/userplugins):

| Plugin | What it adds |
| --- | --- |
| [FakeMuteDeafenCamera](src/userplugins/FakeMuteDeafenCamera) | Fake mute, deafen, and camera-state controls with configurable button behavior. |
| [AllConnectionsEnabled](src/userplugins/allConnectionsEnabled) | Enables all connection types exposed by Discord. |
| [AutoDeleteDMs](src/userplugins/autoDeleteDms) | Automatically deletes DMs after a configurable amount of time. |
| [AutoUnmute](src/userplugins/autoUnmute) | Automatically unmutes/undeafens after server mute/deafen when permissions allow it. |
| [BigFileUpload](src/userplugins/bigFileUpload) | Sends oversized files through supported external upload providers from drag/drop, paste, or the upload button. |
| [MessageCleaner](src/userplugins/messageCleaner) | Bulk message cleanup with rate-limit handling, statistics, and confirmation. |
| [PasswordManager](src/userplugins/passwordManager) | Adds an in-client password-management vault. |
| [SendToAllDMs](src/userplugins/sendtoalldms) | Adds a command for sending a message to multiple friend DMs with blacklist/whitelist controls. This can carry account-enforcement risk if abused. |
| [SpoofSystemV2](src/userplugins/spoofmsgv2) | Locally creates realistic Discord-style system-message spoofs. |
| [TokenLoginManager](src/userplugins/tokenLogin) | Saves/manages account tokens and provides token-based login. Treat stored tokens as highly sensitive credentials. |
| [FollowUser](src/userplugins/vc-followUser) | Adds a user-context action for following a user between voice channels. |
| [IgnoreTerms](src/userplugins/vc-ignoreTerms) | Suppresses Discord's newer terms prompt/handling used by the plugin. |
| [NotifyUserChanges](src/userplugins/vc-notifyUserChanges) | Adds notifications for selected users' voice-channel and online-status changes. |
| [WebcamZoom](src/userplugins/webcamZoom) | Adds aspect-correct webcams, mouse-wheel zoom, drag panning, remembered views, and custom/native fullscreen camera viewing. |

These are in addition to the plugins inherited from Equicord.

## Build EquicordPlus from source

### Requirements

- [Git](https://git-scm.com/download)
- Node.js **22 or newer**
- pnpm

Install pnpm if needed:

```shell
npm install -g pnpm@12.4.2
```

Clone **this repository**:

```shell
git clone https://github.com/Chaython/EquicordPlus.git
cd EquicordPlus
```

Install dependencies:

```shell
pnpm install --frozen-lockfile
```

Build the desktop version:

```shell
pnpm build
```

Inject EquicordPlus into the supported Discord desktop client:

```shell
pnpm inject
```

Remove the injection:

```shell
pnpm uninject
```

Repair an existing injection:

```shell
pnpm repair
```

Build the web/browser version:

```shell
pnpm buildWeb
```

Build standalone desktop and web artifacts:

```shell
pnpm buildStandalone
pnpm buildWebStandalone
```

Generated artifacts are placed under `dist`.

## Updating a local checkout

```shell
cd EquicordPlus
git pull origin main
pnpm install --frozen-lockfile
pnpm build
pnpm inject
```

For web builds:

```shell
git pull origin main
pnpm install --frozen-lockfile
pnpm buildWeb
```

## Development commands

Run TypeScript diagnostics:

```shell
pnpm testTsc
```

Run the linter without modifying source:

```shell
pnpm lint
```

Run the complete repository test command:

```shell
pnpm test
```

Watch/rebuild the desktop client during development:

```shell
pnpm dev
```

Watch the web build:

```shell
pnpm watchWeb
```

## Upstream sync

EquicordPlus tracks [Equicord/Equicord](https://github.com/Equicord/Equicord). The repository's [sync/build workflow](.github/workflows/sync-upstream-release.yml) checks upstream automatically and attempts to merge compatible upstream changes.

The EquicordPlus README is intentionally fork-owned. Automated upstream merges are configured to keep this repository's `README.md` instead of allowing upstream README edits to create a merge conflict. Other conflicts are still surfaced normally and are **not** automatically discarded.

## Credits

EquicordPlus is based on [Equicord](https://github.com/Equicord/Equicord), which is based on [Vencord](https://github.com/Vendicated/Vencord).

Thanks to the Equicord and Vencord contributors whose work forms the base of this fork, and to the authors of user plugins incorporated or adapted in EquicordPlus.

## License

EquicordPlus follows the repository's [GPL-3.0-or-later license](LICENSE).

## Disclaimer

Discord is a trademark of Discord Inc. EquicordPlus is not affiliated with or endorsed by Discord Inc.

Client modifications can violate Discord's Terms of Service. Plugins that automate user actions, bulk-message users, manage account tokens, or alter client behavior can carry additional account or security risk. Review what a plugin does before enabling it, especially on accounts you cannot afford to lose.
