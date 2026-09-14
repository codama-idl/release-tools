import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    describeConfig,
    isNotFound,
    isOtpRequired,
    matchesExpected,
    parseGitHubRepo,
    parseTrustList,
    planTrust,
    preflight,
    summarise,
    withSecondFactor,
} from '../src/trust.mjs';

const expected = { repo: 'codama-idl/codama', file: 'main.yml' };
const good = {
    id: 'abc',
    type: 'github',
    file: 'main.yml',
    repository: 'codama-idl/codama',
    permissions: ['createPackage'],
};

/** `npm trust list --json` prints one pretty-printed object per configuration, concatenated. */
function npmJsonOutput(...configs) {
    return configs.map((config) => `\n${JSON.stringify(config, null, 2)}\n`).join('');
}

test('parseGitHubRepo handles remote URLs and the package.json shorthands npm normalises', () => {
    for (const reference of [
        'git@github.com:codama-idl/codama.git',
        'https://github.com/codama-idl/codama',
        'https://github.com/codama-idl/codama.git',
        'git+https://github.com/codama-idl/codama.git',
        'ssh://git@github.com/codama-idl/codama.git',
        'https://github.com/codama-idl/codama/',
        'github:codama-idl/codama',
        'codama-idl/codama',
    ]) {
        assert.equal(parseGitHubRepo(reference), 'codama-idl/codama', reference);
    }
    assert.equal(parseGitHubRepo('https://gitlab.com/a/b'), null);
    assert.equal(parseGitHubRepo('gitlab:a/b'), null);
    assert.equal(parseGitHubRepo(null), null);
});

test('parseTrustList reads zero, one and several concatenated configurations', () => {
    assert.deepEqual(parseTrustList(''), []);
    assert.deepEqual(parseTrustList('\n\n'), []);
    assert.deepEqual(parseTrustList(npmJsonOutput(good)), [good]);
    const other = { ...good, id: 'def', file: 'release.yml', environment: 'npm "prod"' };
    assert.deepEqual(parseTrustList(npmJsonOutput(good, other)), [good, other]);
});

test('parseTrustList refuses to guess on anything that is not JSON objects', () => {
    assert.throws(() => parseTrustList('No trust configurations found for package (x)'), /Unexpected/);
    assert.throws(() => parseTrustList('[{"id":"abc"}]'), /Unexpected/);
    assert.throws(() => parseTrustList(`${npmJsonOutput(good)}trailing text`), /Unexpected/);
    assert.throws(() => parseTrustList('{"id": "abc"'), /Unexpected/);
});

test('matchesExpected requires this repo, this file, no environment and publish permission', () => {
    assert.equal(matchesExpected(good, expected), true);
    assert.equal(matchesExpected({ ...good, repository: 'Codama-IDL/Codama' }, expected), true);
    assert.equal(matchesExpected({ ...good, permissions: undefined }, expected), true, 'legacy configs allow publish');
    assert.equal(matchesExpected({ ...good, file: 'release.yml' }, expected), false);
    assert.equal(matchesExpected({ ...good, repository: 'someone/fork' }, expected), false);
    assert.equal(matchesExpected({ ...good, environment: 'release' }, expected), false);
    assert.equal(matchesExpected({ ...good, permissions: ['createStagedPackage'] }, expected), false);
    assert.equal(matchesExpected({ ...good, type: 'gitlab' }, expected), false);
});

test('planTrust classifies every package, comparing existing configurations rather than counting them', () => {
    const stale = { ...good, id: 'old', file: 'publish.yml' };
    const configsOf = {
        '@codama/cli': [good],
        '@codama/nodes': [],
        '@codama/errors': [stale],
        '@codama/visitors': [good, stale],
    };
    const registry = {
        exists: (name) => name !== '@codama/upgrade',
        trustConfigurations: (name) => configsOf[name] ?? [],
    };
    const repository = 'https://github.com/codama-idl/codama';
    const results = planTrust({
        ...expected,
        registry,
        packages: [
            { name: '@codama-internal/generators', private: true, repository: null },
            { name: '@codama/cli', private: false, repository },
            { name: '@codama/upgrade', private: false, repository },
            { name: '@codama/nodes', private: false, repository: 'git+https://github.com/codama-idl/codama.git' },
            { name: '@codama/errors', private: false, repository },
            { name: '@codama/visitors', private: false, repository },
            { name: '@codama/stray', private: false, repository: 'https://github.com/someone/fork' },
            { name: '@codama/bare', private: false, repository: null },
        ],
    });
    assert.deepEqual(
        results.map(({ status }) => status),
        ['private', 'trusted', 'missing', 'pending', 'misconfigured', 'trusted', 'mismatch', 'mismatch'],
    );
    assert.deepEqual(results[1].detail, [], 'exactly the expected configuration');
    assert.deepEqual(results[4].detail, [stale], 'the offending configuration, for the revoke hint');
    assert.deepEqual(results[5].detail, [stale], 'extra configuration next to the expected one');
    assert.equal(results[6].detail, 'https://github.com/someone/fork');
    assert.equal(results[7].detail, '(no repository field)');
});

test('isNotFound reads E404 from either stream and nothing else', () => {
    assert.equal(isNotFound({ stdout: '', stderr: 'npm error code E404\nnpm error 404 Not Found' }), true);
    assert.equal(isNotFound({ stdout: '{"error":{"code":"E404"}}', stderr: '' }), true);
    assert.equal(isNotFound({ stdout: '', stderr: 'npm error code E401' }), false);
    assert.equal(isNotFound({ message: 'E404 in the message only' }), false);
});

test('describeConfig renders a configuration on one line', () => {
    assert.equal(describeConfig(good), 'github codama-idl/codama main.yml createPackage (id abc)');
    assert.equal(
        describeConfig({ id: 'x', type: 'github', repository: 'a/b', file: 'f.yml', environment: 'prod' }),
        'github a/b f.yml env prod legacy permissions (id x)',
    );
});

test('summarise fails while anything is unresolved and passes once everything is trusted or planned', () => {
    assert.deepEqual(summarise([{ status: 'private' }, { status: 'trusted' }, { status: 'created' }]), {
        counts: { private: 1, trusted: 1, created: 1 },
        ok: true,
    });
    assert.equal(summarise([{ status: 'trusted' }, { status: 'planned' }]).ok, true);
    for (const status of ['missing', 'mismatch', 'misconfigured', 'pending']) {
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

test('isOtpRequired reads EOTP from either stream', () => {
    assert.equal(isOtpRequired({ stdout: '', stderr: 'npm error code EOTP' }), true);
    assert.equal(isOtpRequired({ stdout: '{"error":{"code":"EOTP"}}', stderr: '' }), true);
    assert.equal(isOtpRequired({ stdout: '', stderr: 'npm error code E404' }), false);
});

test('withSecondFactor authenticates on EOTP and retries exactly once', () => {
    const otp = Object.assign(new Error('otp'), { stderr: 'npm error code EOTP' });
    const other = Object.assign(new Error('boom'), { stderr: 'npm error code E500' });
    const log = [];
    const authenticate = () => log.push('auth');

    // No OTP needed: no authentication.
    assert.equal(
        withSecondFactor(() => 'ok', { authenticate }),
        'ok',
    );
    assert.deepEqual(log, []);

    // OTP needed once: authenticate, retry succeeds.
    let calls = 0;
    const flaky = () => {
        if (calls++ === 0) throw otp;
        return 'ok';
    };
    assert.equal(withSecondFactor(flaky, { authenticate }), 'ok');
    assert.deepEqual(log, ['auth']);

    // Still OTP after authenticating: loud failure, no infinite loop.
    assert.throws(
        () =>
            withSecondFactor(
                () => {
                    throw otp;
                },
                { authenticate },
            ),
        /still requires a one-time password/,
    );
    assert.deepEqual(log, ['auth', 'auth']);

    // Unrelated errors propagate untouched, before and after authenticating.
    assert.throws(
        () =>
            withSecondFactor(
                () => {
                    throw other;
                },
                { authenticate },
            ),
        /boom/,
    );
    assert.deepEqual(log, ['auth', 'auth']);
});
