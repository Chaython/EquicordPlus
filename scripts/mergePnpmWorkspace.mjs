#!/usr/bin/env node
/**
 * Merge pnpm-workspace.yaml catalogs without discarding fork-only entries.
 * Upstream config is authoritative; missing catalog keys and peer ignore
 * entries from EquicordPlus are retained for fork-only packages/scripts.
 */
import fs from "node:fs";
const [, , basePath, oursPath, theirsPath] = process.argv;
if (!basePath || !oursPath || !theirsPath) {
    console.error("Expected BASE OURS THEIRS merge-driver arguments.");
    process.exit(2);
}
const ours = fs.readFileSync(oursPath, "utf8");
const theirs = fs.readFileSync(theirsPath, "utf8");

function section(text, name) {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex(line => new RegExp("^" + name + ":\\s*$").test(line));
    if (start < 0) return { lines, start: -1, end: -1, entries: [] };
    let end = start + 1;
    while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end++;
    return { lines, start, end, entries: lines.slice(start + 1, end) };
}
function keyOf(line) {
    const m = line.match(/^\s{4}([^#][^:]*):/);
    return m?.[1]?.trim().replace(/^["']|["']$/g, "");
}

let result = theirs;
const oursCatalog = section(ours, "catalog");
const theirsCatalog = section(result, "catalog");
if (oursCatalog.start >= 0 && theirsCatalog.start >= 0) {
    const existing = new Set(theirsCatalog.entries.map(keyOf).filter(Boolean));
    const missing = oursCatalog.entries.filter(line => {
        const key = keyOf(line);
        return key && !existing.has(key);
    });
    if (missing.length) {
        const lines = result.split(/\r?\n/);
        lines.splice(theirsCatalog.end, 0, ...missing);
        result = lines.join("\n");
    }
}

// Preserve fork-only ignored peer names while retaining upstream policy.
const oursPeer = section(ours, "peerDependencyRules");
const theirsPeer = section(result, "peerDependencyRules");
if (oursPeer.start >= 0 && theirsPeer.start >= 0) {
    const oursIgnore = section(ours.slice(oursPeer.start, oursPeer.end).join("\n"), "ignoreMissing");
    const theirsIgnore = section(result.slice(theirsPeer.start, theirsPeer.end).join("\n"), "ignoreMissing");
    const present = new Set(theirsIgnore.entries.map(line => line.trim()).filter(Boolean));
    const missing = oursIgnore.entries.filter(line => line.trim() && !present.has(line.trim()));
    if (missing.length) {
        const lines = result.split(/\r?\n/);
        lines.splice(theirsPeer.end, 0, ...missing);
        result = lines.join("\n");
    }
}
fs.writeFileSync(oursPath, result.endsWith("\n") ? result : result + "\n");
