/**
 * Version helpers. Deliberately defensive: inputs may come from
 * hand-edited package.json files, so parsers return `null` rather
 * than throwing and let callers pick the failure mode.
 */

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/;

/** Returns the major of a semver string, or `null` when unparsable. */
export function getMajor(version) {
    if (typeof version !== 'string') return null;
    const match = SEMVER_RE.exec(version);
    return match ? Number(match[1]) : null;
}

/** Returns `true` when the version carries a pre-release identifier (e.g. `2.0.0-rc.3`). */
export function isPrerelease(version) {
    if (typeof version !== 'string') return false;
    const match = SEMVER_RE.exec(version);
    return match ? match[4] !== undefined : false;
}
