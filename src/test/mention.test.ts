import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMentions } from '../core/mention';

test('formatMentions marks folders with a trailing slash and joins with spaces', () => {
  assert.equal(
    formatMentions([
      { path: 'services/api-gateway', isDir: true },
      { path: 'services/api-gateway/src/index.ts', isDir: false },
      { path: 'docs/', isDir: true },
      { path: 'frontend\\web-app', isDir: true },
    ]),
    '@services/api-gateway/ @services/api-gateway/src/index.ts @docs/ @frontend/web-app/',
  );
  assert.equal(formatMentions([]), '');
});
