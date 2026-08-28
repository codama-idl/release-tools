import { getMajor } from './versions.mjs';

/**
 * The postversion guard: pure analysis of the version changes produced by
 * `changeset version`, enforcing the invariants of RELEASING.md
 * (https://github.com/codama-idl/spec/blob/HEAD/RELEASING.md):
 *
 * 1. A major crossing may only happen on `main`, and the outgoing major's
 *    `N.x` maintenance branch must already have been cut. Crossings from
 *    major 0 are exempt from the branch requirement (pre-1.0 repos get
 *    their first maintenance branch at their first cut).
 * 2. In a workspace with multiple public packages, all public majors must
 *    stay equal (the same-major invariant).
 *
 * @param {object} input
 * @param {string} input.branch - The branch the release runs on (e.g. `main`, `1.x`).
 * @param {Set<string>} input.remoteBranches - Names of branches existing on the remote.
 * @param {Array<{name: string, private?: boolean, oldVersion: string | null, newVersion: string | null}>} input.packages
 * @returns {{violations: string[], notes: string[]}}
 */
export function analyseVersionChanges({ branch, remoteBranches, packages }) {
    const violations = [];
    const notes = [];
    const publicPackages = packages.filter((pkg) => !pkg.private && pkg.newVersion !== null);

    for (const pkg of publicPackages) {
        const newMajor = getMajor(pkg.newVersion);
        if (newMajor === null) {
            violations.push(`${pkg.name}: cannot parse new version "${pkg.newVersion}".`);
            continue;
        }
        if (pkg.oldVersion === null) {
            notes.push(`${pkg.name}: new package at ${pkg.newVersion}.`);
            continue;
        }
        const oldMajor = getMajor(pkg.oldVersion);
        if (oldMajor === null) {
            violations.push(`${pkg.name}: cannot parse previous version "${pkg.oldVersion}".`);
            continue;
        }
        if (newMajor < oldMajor) {
            violations.push(`${pkg.name}: version went backwards (${pkg.oldVersion} -> ${pkg.newVersion}).`);
            continue;
        }
        if (newMajor === oldMajor) continue;

        // Major crossing.
        notes.push(`${pkg.name}: major crossing ${pkg.oldVersion} -> ${pkg.newVersion}.`);
        if (branch !== 'main') {
            violations.push(
                `${pkg.name}: major crossing (${pkg.oldVersion} -> ${pkg.newVersion}) on branch "${branch}". ` +
                    'Majors may only cross on `main`. See RELEASING.md.',
            );
        }
        const maintenanceBranch = `${oldMajor}.x`;
        if (oldMajor > 0 && !remoteBranches.has(maintenanceBranch)) {
            violations.push(
                `${pkg.name}: major crossing (${pkg.oldVersion} -> ${pkg.newVersion}) but the ` +
                    `\`${maintenanceBranch}\` maintenance branch does not exist. Run the cut workflow first. ` +
                    'See RELEASING.md.',
            );
        }
    }

    // Same-major invariant across public workspace packages.
    if (publicPackages.length > 1) {
        const majors = new Map();
        for (const pkg of publicPackages) {
            const major = getMajor(pkg.newVersion);
            if (major === null) continue;
            if (!majors.has(major)) majors.set(major, []);
            majors.get(major).push(`${pkg.name}@${pkg.newVersion}`);
        }
        if (majors.size > 1) {
            const detail = [...majors.entries()]
                .map(([major, names]) => `major ${major}: ${names.join(', ')}`)
                .join(' | ');
            violations.push(
                `Public package majors diverge (${detail}). All public packages must share one major. ` +
                    'See the same-major invariant in RELEASING.md.',
            );
        }
    }

    return { violations, notes };
}
