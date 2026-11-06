import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstPartBelow, isAtOrInside, isInside, literalGlob, repoRelative } from '../core/paths';

test('isInside and isAtOrInside compare whole folder names', () => {
  assert.equal(isInside('/a/b/c', '/a/b'), true);
  assert.equal(isInside('/a/b', '/a/b'), false);
  assert.equal(isInside('/a/bc', '/a/b'), false, 'a longer name is not inside');
  assert.equal(isInside('/a', '/a/b'), false);
  assert.equal(isAtOrInside('/a/b', '/a/b'), true);
  assert.equal(isAtOrInside('/a/b/c', '/a/b'), true);
});

test('the root folder contains everything', () => {
  assert.equal(isInside('/srv', '/'), true);
  assert.equal(firstPartBelow('/srv/app', '/'), 'srv');
});

test('repoRelative gives git-style paths', () => {
  assert.equal(repoRelative('/w/repo', '/w/repo/src/a.ts'), 'src/a.ts');
  assert.equal(repoRelative('/w/repo', '/w/repo'), '');
  assert.equal(firstPartBelow('/w/repo/src/a.ts', '/w'), 'repo');
});

test('literalGlob keeps glob characters in folder names literal', () => {
  assert.equal(literalGlob('app/[id]/page'), 'app/[[]id]/page');
  assert.equal(literalGlob('a*b?c{d}'), 'a[*]b[?]c[{]d[}]');
  assert.equal(literalGlob('src/utils'), 'src/utils');
});
