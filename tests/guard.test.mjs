import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyseVersionChanges } from '../src/guard.mjs';

const onMain = { branch: 'main', remoteBranches: new Set(['main', '1.x']) };

function pkg(name, oldVersion, newVersion, isPrivate = false) {
    return { name, oldVersion, newVersion, private: isPrivate };
}

test('patch and minor bumps pass anywhere', () => {
    for (const branch of ['main', '1.x']) {
        const { violations } = analyseVersionChanges({
            ...onMain,
            branch,
            packages: [pkg('a', '1.2.3', '1.3.0'), pkg('b', '1.2.3', '1.2.4')],
        });
        assert.deepEqual(violations, []);
    }
});

test('stable major crossing passes on main when the maintenance branch exists', () => {
    const { violations, notes } = analyseVersionChanges({
        ...onMain,
        packages: [pkg('a', '1.9.2', '2.0.0')],
    });
    assert.deepEqual(violations, []);
    assert.match(notes[0], /major crossing 1\.9\.2 -> 2\.0\.0/);
});

test('rc major crossing passes on main when the maintenance branch exists', () => {
    const { violations } = analyseVersionChanges({
        ...onMain,
        packages: [pkg('a', '1.9.2', '2.0.0-rc.0')],
    });
    assert.deepEqual(violations, []);
});

test('major crossing fails off main', () => {
    const { violations } = analyseVersionChanges({
        branch: '1.x',
        remoteBranches: new Set(['main', '1.x']),
        packages: [pkg('a', '1.9.2', '2.0.0')],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /only cross on `main`/);
});

test('major crossing fails when the maintenance branch is missing', () => {
    const { violations } = analyseVersionChanges({
        branch: 'main',
        remoteBranches: new Set(['main']),
        packages: [pkg('a', '1.9.2', '2.0.0-rc.0')],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /`1\.x` maintenance branch does not exist/);
});

test('crossing from major 0 is exempt from the maintenance-branch requirement', () => {
    const { violations } = analyseVersionChanges({
        branch: 'main',
        remoteBranches: new Set(['main']),
        packages: [pkg('a', '0.13.2', '1.0.0')],
    });
    assert.deepEqual(violations, []);
});

test('crossing from major 0 still requires main', () => {
    const { violations } = analyseVersionChanges({
        branch: 'feature/x',
        remoteBranches: new Set(['main']),
        packages: [pkg('a', '0.13.2', '1.0.0')],
    });
    assert.equal(violations.length, 1);
});

test('diverging public majors fail; private packages are ignored', () => {
    const { violations } = analyseVersionChanges({
        ...onMain,
        packages: [
            pkg('a', '1.9.2', '2.0.0-rc.0'),
            pkg('b', '1.4.1', '1.4.2'),
            pkg('internal', '0.0.0', '0.0.0', true),
        ],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /majors diverge/);
});

test('equal public majors pass in a monorepo', () => {
    const { violations } = analyseVersionChanges({
        ...onMain,
        packages: [pkg('a', '1.9.2', '1.10.0'), pkg('b', '1.4.1', '1.4.2'), pkg('c', null, '1.0.0')],
    });
    assert.deepEqual(violations, []);
});

test('new packages are noted, not blocked', () => {
    const { violations, notes } = analyseVersionChanges({
        ...onMain,
        packages: [pkg('a', null, '1.0.0')],
    });
    assert.deepEqual(violations, []);
    assert.match(notes[0], /new package/);
});

test('backwards versions fail', () => {
    const { violations } = analyseVersionChanges({
        ...onMain,
        packages: [pkg('a', '2.0.0', '1.9.9')],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /backwards/);
});

test('unparsable versions fail loudly', () => {
    const { violations } = analyseVersionChanges({
        ...onMain,
        packages: [pkg('a', '1.0.0', 'not-semver')],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /cannot parse/);
});
