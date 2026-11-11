#!/usr/bin/env node
/**
 * EquicordPlus package.json merge policy.
 * Keep fork-owned metadata and fork-only scripts/dependencies, while taking
 * upstream version, package manager, engines, and shared toolchain definitions.
 * Git invokes this as: node mergePackageJson.mjs BASE OURS THEIRS
 */
import fs from "node:fs";

const [, , basePath, oursPath, theirsPath] = process.argv;
if (!basePath || !oursPath || !theirsPath) {
    console.error("Expected BASE OURS THEIRS merge-driver arguments.");
    process.exit(2);
}
const read = path => JSON.parse(fs.readFileSync(path, "utf8"));
const ours = read(oursPath);
const theirs = read(theirsPath);
const merged = {
    ...theirs,
    ...ours,
    version: theirs.version,
    packageManager: theirs.packageManager,
    engines: theirs.engines ?? ours.engines,
};

// Upstream definitions win for shared scripts; fork-only scripts survive.
merged.scripts = {
    ...(theirs.scripts ?? {}),
    ...Object.fromEntries(Object.entries(ours.scripts ?? {}).filter(([key]) => !(key in (theirs.scripts ?? {})))),
};

// Upstream owns shared dependency versions; fork-only packages remain available.
for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    merged[section] = {
        ...(theirs[section] ?? {}),
        ...Object.fromEntries(Object.entries(ours[section] ?? {}).filter(([key]) => !(key in (theirs[section] ?? {})))),
    };
    if (!Object.keys(merged[section]).length) delete merged[section];
}

// Explicitly preserve the fork's package identity and metadata.
for (const key of ["name", "private", "description", "homepage", "bugs", "repository", "license", "author"]) {
    if (Object.hasOwn(ours, key)) merged[key] = ours[key];
}
fs.writeFileSync(oursPath, JSON.stringify(merged, null, 4) + "\n");
