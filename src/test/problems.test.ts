import assert from 'node:assert/strict';
import { test } from 'node:test';
import { problemBadge } from '../core/problems';

test('problem badges count errors and warnings, like the built-in Explorer', () => {
  assert.equal(problemBadge(0, 0), undefined);
  assert.deepEqual(problemBadge(1, 0), { badge: '1', tooltip: '1 problem in this file', isError: true });
  assert.deepEqual(problemBadge(0, 3), { badge: '3', tooltip: '3 problems in this file', isError: false });
  assert.deepEqual(problemBadge(4, 8), { badge: '9+', tooltip: '12 problems in this file', isError: true });
});
