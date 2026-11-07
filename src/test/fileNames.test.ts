import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkNewName, checkNewPath } from '../core/fileNames';

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
