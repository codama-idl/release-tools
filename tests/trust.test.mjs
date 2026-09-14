import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasTrustRelationship, parseGitHubRepo, planTrust, preflight, summarise } from '../src/trust.mjs';

test('parseGitHubRepo handles ssh, https, .git suffixes and trailing slashes', () => {
    for (const url of [
        'git@github.com:codama-idl/codama.git',
        'https://github.com/codama-idl/codama',
        'https://github.com/codama-idl/codama.git',
        'git+https://github.com/codama-idl/codama.git',
        'ssh://git@github.com/codama-idl/codama.git',
        'https://github.com/codama-idl/codama/',
    ]) {
        assert.equal(parseGitHubRepo(url), 'codama-idl/codama', url);
    }
    assert.equal(parseGitHubRepo('https://gitlab.com/a/b'), null);
    assert.equal(parseGitHubRepo(null), null);
});

test('hasTrustRelationship reads arrays, wrapped arrays and single objects, and refuses to guess', () => {
    assert.equal(hasTrustRelationship('[]'), false);
    assert.equal(hasTrustRelationship('[{"id":"abc","provider":"github"}]'), true);
    assert.equal(hasTrustRelationship('{"trustedPublishers":[]}'), false);
    assert.equal(hasTrustRelationship('{"trustedPublishers":[{"id":"abc"}]}'), true);
    assert.equal(hasTrustRelationship('{"id":"abc","file":"main.yml"}'), true);
    assert.throws(() => hasTrustRelationship('No trusted publishers configured.'), /Unexpected/);
    assert.throws(() => hasTrustRelationship('"text"'), /Unexpected/);
});

test('planTrust classifies every package without touching pending ones', () => {
    const repo = 'codama-idl/codama';
    const registry = {
        exists: (name) => name !== '@codama/upgrade',
        isTrusted: (name) => name === '@codama/cli',
    };
    const results = planTrust({
        repo,
        registry,
        packages: [
            { name: '@codama-internal/generators', private: true, repository: null },
            { name: '@codama/cli', private: false, repository: 'https://github.com/codama-idl/codama' },
            { name: '@codama/upgrade', private: false, repository: 'https://github.com/codama-idl/codama' },
            { name: '@codama/nodes', private: false, repository: 'git+https://github.com/codama-idl/codama.git' },
            { name: '@codama/stray', private: false, repository: 'https://github.com/someone/fork' },
            { name: '@codama/bare', private: false, repository: null },
        ],
    });
    assert.deepEqual(
        results.map(({ status }) => status),
        ['private', 'trusted', 'missing', 'pending', 'mismatch', 'mismatch'],
    );
    assert.equal(results[4].detail, 'https://github.com/someone/fork');
    assert.equal(results[5].detail, '(no repository field)');
});

test('summarise fails while anything is unresolved and passes once everything is trusted or planned', () => {
    assert.deepEqual(summarise([{ status: 'private' }, { status: 'trusted' }, { status: 'created' }]), {
        counts: { private: 1, trusted: 1, created: 1 },
        ok: true,
    });
    assert.equal(summarise([{ status: 'trusted' }, { status: 'planned' }]).ok, true);
    for (const status of ['missing', 'mismatch', 'pending']) {
        assert.equal(summarise([{ status: 'trusted' }, { status }]).ok, false, status);
    }
});

test('preflight rejects old npm and logged-out sessions', () => {
    assert.throws(() => preflight({ version: () => '11.6.2', whoami: () => 'me' }), /11\.15\.0\+ required/);
    assert.throws(
        () =>
            preflight({
                version: () => '11.15.0',
                whoami: () => {
                    throw new Error('ENEEDAUTH');
                },
            }),
        /npm login/,
    );
    assert.deepEqual(preflight({ version: () => '12.0.2', whoami: () => 'lorisleiva' }), {
        version: '12.0.2',
        user: 'lorisleiva',
    });
});
