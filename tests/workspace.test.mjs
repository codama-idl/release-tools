import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { discoverPackages, parsePnpmWorkspacePackages } from '../src/workspace.mjs';

function fixture() {
    return mkdtempSync(join(tmpdir(), 'release-tools-test-'));
}

function writePackage(dir, contents) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(contents));
}

test('parsePnpmWorkspacePackages handles quoted and bare entries', () => {
    assert.deepEqual(parsePnpmWorkspacePackages("packages:\n  - 'packages/*'\n"), ['packages/*']);
    assert.deepEqual(parsePnpmWorkspacePackages('packages:\n  - "a"\n  - b\ncatalog:\n  x: 1\n'), ['a', 'b']);
});

test('discoverPackages: single-package repo', () => {
    const root = fixture();
    writePackage(root, { name: 'solo', version: '1.2.3' });
    const packages = discoverPackages(root);
    assert.equal(packages.length, 1);
    assert.equal(packages[0].name, 'solo');
    assert.equal(packages[0].private, false);
});

test('discoverPackages: pnpm workspace with dir/* pattern', () => {
    const root = fixture();
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    writePackage(root, { name: 'root', version: '0.0.0', private: true });
    writePackage(join(root, 'packages/a'), { name: '@x/a', version: '1.0.0' });
    writePackage(join(root, 'packages/b'), { name: '@x/b', version: '1.1.0', private: true });
    mkdirSync(join(root, 'packages/not-a-package'));
    const packages = discoverPackages(root);
    assert.deepEqual(
        packages.map((pkg) => [pkg.name, pkg.private]),
        [
            ['@x/a', false],
            ['@x/b', true],
        ],
    );
});

test('discoverPackages: npm workspaces field', () => {
    const root = fixture();
    writePackage(root, { name: 'root', version: '0.0.0', private: true, workspaces: ['libs/*'] });
    writePackage(join(root, 'libs/a'), { name: 'a', version: '2.0.0' });
    const packages = discoverPackages(root);
    assert.deepEqual(
        packages.map((pkg) => pkg.name),
        ['a'],
    );
});

test('discoverPackages: unsupported glob throws', () => {
    const root = fixture();
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/**\n');
    writePackage(root, { name: 'root', version: '0.0.0' });
    assert.throws(() => discoverPackages(root), /Unsupported workspace pattern/);
});
