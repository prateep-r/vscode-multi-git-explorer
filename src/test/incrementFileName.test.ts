import assert from 'node:assert/strict';
import { test } from 'node:test';
import { incrementFileName } from '../core/vs/incrementFileName';

test('incrementFileName, simple: adds " copy", then counts up', () => {
  assert.equal(incrementFileName('app.ts', false, 'simple'), 'app copy.ts');
  assert.equal(incrementFileName('app copy.ts', false, 'simple'), 'app copy 2.ts');
  assert.equal(incrementFileName('app copy 9.ts', false, 'simple'), 'app copy 10.ts');
  assert.equal(incrementFileName('archive.tar.gz', false, 'simple'), 'archive.tar copy.gz');
  assert.equal(incrementFileName('.env', false, 'simple'), '.env copy');
  assert.equal(incrementFileName('Makefile', false, 'simple'), 'Makefile copy');
  assert.equal(incrementFileName('src.old', true, 'simple'), 'src.old copy');
  assert.equal(incrementFileName('src copy', true, 'simple'), 'src copy 2');
});

test('incrementFileName, smart: counts the number in the name, or adds one', () => {
  assert.equal(incrementFileName('test.js', false, 'smart'), 'test.1.js');
  assert.equal(incrementFileName('test.1.js', false, 'smart'), 'test.2.js');
  assert.equal(incrementFileName('test-09.js', false, 'smart'), 'test-10.js');
  assert.equal(incrementFileName('1.test.js', false, 'smart'), '2.test.js');
  assert.equal(incrementFileName('001.txt', false, 'smart'), '002.txt');
  assert.equal(incrementFileName('test', false, 'smart'), 'test1');
  assert.equal(incrementFileName('test9', false, 'smart'), 'test10');
  assert.equal(incrementFileName('folder', true, 'smart'), 'folder.1');
  assert.equal(incrementFileName('folder2', true, 'smart'), 'folder3');
  assert.equal(incrementFileName('1.folder', true, 'smart'), '2.folder');
});
