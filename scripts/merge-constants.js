#!/usr/bin/env node
/**
 * scripts/merge-constants.js
 *
 * Git merge driver for `src/utils/constants.ts`.
 *
 * Merges Equicord/Equicord:main (head) into this fork while keeping
 * EquicordPlus-only constants on top of head's changes.
 *
 * Strategy ("theirs + our patch"):
 *   - upstream/head `constants.ts` is the base (Equicord's values win for
 *     shared keys).
 *   - EquicordPlus-only metadata is layered back on top:
 *       * TESTCORD_GUILD_ID
 *       * Chaython / Benjii entries inside EquicordDevs
 *       * TestcordDevs and TestcordDevsById
 *
 * Git invokes merge drivers as: <driver> %O %A %B
 *   %O  merge-base file       (ignored: we deliberately rebase our metadata onto head)
 *   %A  our branch's version  (the merged result is written here)
 *   %B  upstream/head version
 *
 * The driver is intentionally lenient so an upstream refactor never aborts the
 * whole sync: a missing insertion point falls back to appending a valid,
 * self-contained block at the end of the file instead of throwing. Output
 * always stays valid TypeScript so subsequent type checking and builds remain
 * meaningful (the file is parsed by the AST-based scripts/generateDevsList.ts).
 *
 * Wired into .github/workflows/sync-upstream-release.yml via a temporary
 * attributes file (core.attributesFile), so the policy applies during the
 * automated upstream sync without touching the committed .gitattributes or
 * requiring local driver configuration.
 */

"use strict";

const fs = require("node:fs");

// Git invokes merge drivers as: <driver> %O %A %B
//   argv[2] = %O merge-base (ignored)
//   argv[3] = %A ours       (merged result is written here)
//   argv[4] = %B theirs/upstream
const [, , basePath, oursPath, theirsPath] = process.argv;

if (!oursPath || !theirsPath) {
    throw new Error("usage: node scripts/merge-constants.js %O %A %B");
}

// EquicordPlus-only metadata, taken from our branch's version of the file.
const ours = fs.readFileSync(oursPath, "utf8");
// Equicord upstream (head) - the base we layer our metadata onto.
let upstream = fs.readFileSync(theirsPath, "utf8");

const warnings = [];

/**
 * Insert `value` immediately after the first occurrence of `marker`, unless
 * `value` is already present verbatim. When `marker` cannot be found (upstream
 * refactored the surrounding code) `fallback` - a valid, self-contained block -
 * is appended at the end of the file instead of throwing, so the sync keeps
 * running and the constant is preserved.
 */
function insertOnce(text, marker, value, fallback) {
    if (text.includes(value.trim())) return text;

    const at = text.indexOf(marker);
    if (at >= 0) {
        return text.slice(0, at + marker.length) + "\n" + value + text.slice(at + marker.length);
    }

    warnings.push(`insertion point not found: ${JSON.stringify(marker)}; appending fallback at EOF`);
    const sep = text.endsWith("\n") ? "" : "\n";
    return text + sep + "\n" + fallback + "\n";
}

/**
 * TESTCORD_GUILD_ID - standalone export, placed next to GUILD_ID.
 */
const testcordGuild = ours.match(/^export const TESTCORD_GUILD_ID = .*;$/m)?.[0];
if (testcordGuild && !/^export const TESTCORD_GUILD_ID = /m.test(upstream)) {
    upstream = insertOnce(
        upstream,
        'export const GUILD_ID = "1173279886065029291";',
        testcordGuild,
        testcordGuild
    );
}

/**
 * EquicordDevs - our maintainer/dev entries merged into Equicord's object.
 * Entries already present upstream are skipped (no duplicate properties).
 */
const customEntries = [
    '    // EquicordPlus maintainer and author of maintained fork plugins.\n    Chaython: { name: "Chaython", id: 0n },',
    '    Benjii: { name: "Benjii", id: 463702169443368970n },'
];
const missingDevEntries = customEntries.filter((entry) => {
    const key = entry.split("\n").at(-1).trim();
    return !upstream.includes(key);
});
const devsMarker = "export const EquicordDevs = Object.freeze({";
if (missingDevEntries.length > 0) {
    if (upstream.includes(devsMarker)) {
        for (const entry of missingDevEntries) {
            upstream = insertOnce(upstream, devsMarker, entry);
        }
    } else {
        // Fallback: one self-contained object so the file stays valid TS even
        // if upstream renamed/removed its EquicordDevs declaration.
        const body = missingDevEntries.join("\n");
        upstream += `\n\nexport const EquicordPlusDevs = Object.freeze({\n${body}\n});\n`;
        warnings.push("EquicordDevs marker missing; added EquicordPlusDevs fallback object");
    }
}

/**
 * TestcordDevs / TestcordDevsById - standalone blocks appended after
 * EquicordDevsById, only when upstream does not already declare them.
 */
const testcord = ours.match(/export const TestcordDevs = Object\.freeze\([\s\S]*?\} satisfies Record<string, Dev>\);/)?.[0];
const testcordById = ours.match(/export const TestcordDevsById = \/\* #__PURE__\*\/\s*\(\(\) =>[\s\S]*?\)\(\) as Record<string, Dev>;/)?.[0];
if (testcord && !upstream.includes("export const TestcordDevs =")) {
    const marker = ")() as Record<string, Dev>;";
    const start = upstream.indexOf("export const EquicordDevsById =");
    const at = start >= 0 ? upstream.indexOf(marker, start) : -1;
    const fallback = (testcord + "\n\n" + (testcordById || "")).trimEnd();
    if (at >= 0) {
        const end = at + marker.length;
        upstream =
            upstream.slice(0, end) + "\n\n" + testcord +
            (testcordById ? "\n\n" + testcordById : "") + "\n" + upstream.slice(end);
    } else {
        warnings.push("EquicordDevsById marker missing; appending TestcordDevs at EOF");
        upstream += "\n\n" + fallback + "\n";
    }
}

if (warnings.length > 0) {
    for (const warning of warnings) {
        console.warn(`[merge-constants] ${warning}`);
    }
}

fs.writeFileSync(oursPath, upstream);
