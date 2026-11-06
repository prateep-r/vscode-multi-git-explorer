import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoRevealOn, isRevealExcluded } from '../core/reveal';
import { parse, type ParsedExpression } from '../core/vs/glob';

test('explorer.autoReveal is on unless false', () => {
  assert.equal(autoRevealOn(true), true);
  assert.equal(autoRevealOn('focusNoScroll'), true);
  assert.equal(autoRevealOn(false), false);
  assert.equal(autoRevealOn(undefined), false);
});

test('explorer.autoRevealExclude checks the file and every folder above it', () => {
  const matches = parse({ '**/node_modules': true, '**/*.gen.ts': true, '**/*.js': { when: '$(basename).ts' } }) as ParsedExpression;
  assert.equal(isRevealExcluded(matches, 'node_modules/pkg/index.js'), true, 'an excluded folder above it');
  assert.equal(isRevealExcluded(matches, 'src/a/node_modules/x.ts'), true);
  assert.equal(isRevealExcluded(matches, 'src/api.gen.ts'), true, 'the file itself');
  assert.equal(isRevealExcluded(matches, 'src/node_modules.ts'), false);
  assert.equal(isRevealExcluded(matches, 'src/app.ts'), false);
  assert.equal(isRevealExcluded(matches, 'src/app.js', name => name === 'app.ts'), true, 'when clauses see the siblings');
  assert.equal(isRevealExcluded(matches, 'src/app.js', () => false), false);
});
