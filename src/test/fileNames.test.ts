import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkNewName, checkNewPath, copyName } from '../core/fileNames';

test('copyName names copies like the built-in Explorer', () => {
  assert.equal(copyName('app.ts', false, 1), 'app copy.ts');
  assert.equal(copyName('app.ts', false, 2), 'app copy 2.ts');
  assert.equal(copyName('archive.tar.gz', false, 1), 'archive.tar copy.gz');
  assert.equal(copyName('.env', false, 1), '.env copy');
  assert.equal(copyName('Makefile', false, 3), 'Makefile copy 3');
  assert.equal(copyName('src.old', true, 1), 'src.old copy');
});

test('checkNewName accepts plain names only', () => {
  assert.equal(checkNewName('index.ts'), undefined);
  assert.equal(checkNewName('.env'), undefined);
  assert.ok(checkNewName(''));
  assert.ok(checkNewName(' index.ts'));
  assert.ok(checkNewName('src/index.ts'));
  assert.ok(checkNewName('..'));
});

test('checkNewPath accepts names and relative paths inside the folder', () => {
  assert.equal(checkNewPath('/w/docs', 'README.md'), undefined);
  assert.equal(checkNewPath('/w/docs', 'guides/setup.md'), undefined);
  assert.equal(checkNewPath('/w/docs', 'images/'), undefined, 'a trailing slash is fine for a folder');
  assert.equal(checkNewPath('/w/docs', '  '), undefined, 'nothing typed yet');
  assert.equal(checkNewPath('/', 'tmp.txt'), undefined, 'works in the root folder too');
  assert.match(checkNewPath('/w/docs', '/etc/passwd')!, /relative path/);
  assert.match(checkNewPath('/w/docs', '../escape.md')!, /inside this folder/);
  assert.match(checkNewPath('/w/docs', 'a//b.md')!, /empty/);
  assert.match(checkNewPath('/w/docs', 'guides/ setup.md')!, /space/);
});
