import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getMajor, isAtLeast, isPrerelease } from '../src/versions.mjs';

test('getMajor parses stable and pre-release versions', () => {
    assert.equal(getMajor('1.9.2'), 1);
    assert.equal(getMajor('2.0.0-rc.8'), 2);
    assert.equal(getMajor('0.13.2'), 0);
    assert.equal(getMajor('10.20.30+build.5'), 10);
});

test('getMajor returns null on garbage', () => {
    assert.equal(getMajor('not-a-version'), null);
    assert.equal(getMajor('1.2'), null);
    assert.equal(getMajor(''), null);
    assert.equal(getMajor(undefined), null);
    assert.equal(getMajor(2), null);
});

test('isPrerelease', () => {
    assert.equal(isPrerelease('2.0.0-rc.0'), true);
    assert.equal(isPrerelease('2.0.0'), false);
    assert.equal(isPrerelease('2.0.0+build'), false);
});

test('isAtLeast compares release parts and ignores pre-release tags', () => {
    assert.equal(isAtLeast('11.15.0', '11.15.0'), true);
    assert.equal(isAtLeast('12.0.2', '11.15.0'), true);
    assert.equal(isAtLeast('11.6.2', '11.15.0'), false);
    assert.equal(isAtLeast('11.15.0-pre.1', '11.15.0'), true);
    assert.equal(isAtLeast('garbage', '1.0.0'), false);
});
