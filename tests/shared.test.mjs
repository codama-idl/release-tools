import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bumpReleaseLine } from '../src/tasks/shared.mjs';

test('bumpReleaseLine bumps the shared-workflow input and the legacy env, and refuses anything else', () => {
    assert.equal(
        bumpReleaseLine('jobs:\n  release:\n    with:\n      release-version: 1.x\n', 1, 2),
        'jobs:\n  release:\n    with:\n      release-version: 2.x\n',
    );
    assert.equal(bumpReleaseLine('env:\n  RELEASE_VERSION: 1.x\n', 1, 2), 'env:\n  RELEASE_VERSION: 2.x\n');
    assert.throws(() => bumpReleaseLine('env:\n  RELEASE_VERSION: 3.x\n', 1, 2), /release-version: 1\.x/);
});
