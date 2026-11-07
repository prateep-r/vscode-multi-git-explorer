import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeNester, nestFiles } from '../core/nesting';

const patterns = {
  'package.json': 'package-lock.json, yarn.lock',
  '*.ts': '${capture}.js, ${capture}.d.ts',
  'tsconfig.json': 'tsconfig.*.json',
  'ignored': 7,
};

test('files nest under their parent pattern, like the built-in Explorer', () => {
  const nester = makeNester(patterns, false);
  const nests = nestFiles(nester, ['package.json', 'package-lock.json', 'a.ts', 'a.js', 'a.d.ts', 'b.js', 'tsconfig.json', 'tsconfig.build.json'], 'src', false);
  assert.deepEqual(nests.get('package.json'), ['package-lock.json']);
  assert.deepEqual([...(nests.get('a.ts') ?? [])].sort(), ['a.d.ts', 'a.js']);
  assert.deepEqual(nests.get('tsconfig.json'), ['tsconfig.build.json']);
  assert.deepEqual(nests.get('b.js'), [], 'a file with nothing under it is still listed');
  assert.ok(!nests.has('a.js'), 'nested files are not top-level');
});

test('names are compared without case where the disk ignores it, and keep their own case', () => {
  const nester = makeNester(patterns, true);
  const nests = nestFiles(nester, ['Package.json', 'package-lock.json'], 'x', true);
  assert.deepEqual(nests.get('Package.json'), ['package-lock.json']);
});

test('patterns that are not an object nest nothing', () => {
  for (const patterns of [undefined, null, 'x']) {
    const nests = nestFiles(makeNester(patterns, false), ['a.ts', 'a.js'], 'src', false);
    assert.deepEqual([...nests.values()], [[], []]);
  }
});
