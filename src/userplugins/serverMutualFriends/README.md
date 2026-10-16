# Server Mutual Friends — EquicordPlus

**Author:** [Chaython](https://github.com/Chaython)  
**License:** GPL-3.0-or-later

Unverified prototype. Designed for an Equicord / Vencord source build and **not** tested against a live Discord session. Uses Discord client internals, which may change and whose automation may violate Discord's rules.

## Install

1. The plugin is included in `src/userplugins/serverMutualFriends/` on the EquicordPlus `main` branch.
2. Rebuild EquicordPlus using your usual local workflow.
3. Enable `ServerMutualFriends` in plugins. Open its **Info** view for commands, limitations, privacy and rate-limit notes.
4. Open a text channel in the target server; let the member list populate.
5. Run `/mutualscan`; check `/mutualstatus`; use `/mutualstop` to cancel.
6. Run `/mutualresults` to copy CSV to your clipboard, then paste into a file or spreadsheet.

## Limitations

- Only scans member IDs already loaded in the Discord client. For large servers this is **not every server member**.
- Uses Discord client profile requests through the internal REST wrapper, and makes one profile request every 2.5 seconds. Stops on rate limits instead of retrying. There is no official bot API for third-party mutual friend lists.
- Counts can be unavailable, for example due to privacy settings or client/API changes; an unknown/error is not zero mutual friends.
- Doesn't send any messages to server members, extract account tokens, or make network requests to third parties.
- Results are only held in memory until client reload or new scan. `/mutualresults` copies all results, including zero and unknown.
- Do not run it repeatedly at scale. Discord prohibits unauthorized automation of standard user accounts.

## Plugin info panel

The plugin's **Info** modal displays the usage commands, author attribution, cached-member coverage warning, rate-limit safeguards, privacy behavior and API compatibility note. These warnings are intentionally visible in Discord settings.

**Implementation status:** Syntax checked, but not tested with a live Discord account. The built-in Discord profile API and client cache are unofficial and may change.