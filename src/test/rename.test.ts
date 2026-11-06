import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { oldSettingName, scopesToCopy } from '../core/rename';

test('old setting names keep the part after the prefix', () => {
  assert.equal(oldSettingName('multiGitExplorer.scanDepth'), 'multiRepoExplorer.scanDepth');
  assert.equal(oldSettingName('git.path'), undefined);
});

test('every setting has an old name to copy from', () => {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  for (const name of Object.keys(manifest.contributes.configuration.properties)) {
    assert.ok(oldSettingName(name), name);
  }
});

test('copies an old value only where the new setting is unset', () => {
  const scopes = ['globalValue', 'workspaceValue'] as const;
  assert.deepEqual(scopesToCopy({ globalValue: 5 }, undefined, [...scopes]), ['globalValue']);
  assert.deepEqual(scopesToCopy({ globalValue: 5, workspaceValue: 2 }, { globalValue: 8 }, [...scopes]), ['workspaceValue']);
  assert.deepEqual(scopesToCopy({ globalValue: false }, {}, [...scopes]), ['globalValue']);
  assert.deepEqual(scopesToCopy(undefined, undefined, [...scopes]), []);
});

test('only looks at the scopes asked for', () => {
  assert.deepEqual(scopesToCopy({ globalValue: 1, workspaceValue: 2 }, {}, ['workspaceValue']), ['workspaceValue']);
});
