import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guessHostKind, parseRemote, webUrl, type WebRepo } from '../core/remoteUrl';

test('parseRemote reads SSH, scp-style, and HTTPS remotes', () => {
  assert.deepEqual(parseRemote('git@github.com:prateep-r/sql-query-tuning.git'), {
    origin: 'https://github.com',
    path: 'prateep-r/sql-query-tuning',
    host: 'github.com',
  });
  assert.deepEqual(parseRemote('ssh://git@gitdev.example.com:2222/secure-coding/secure-coding.git'), {
    origin: 'https://gitdev.example.com',
    path: 'secure-coding/secure-coding',
    host: 'gitdev.example.com',
  });
  assert.deepEqual(parseRemote('https://user:token@gitlab.example.work/group/sub/repo.git/'), {
    origin: 'https://gitlab.example.work',
    path: 'group/sub/repo',
    host: 'gitlab.example.work',
  });
  assert.deepEqual(parseRemote('http://10.0.0.1:8080/git/TEAM/app.git'), {
    origin: 'http://10.0.0.1:8080',
    path: 'git/TEAM/app',
    host: '10.0.0.1',
  });
  assert.deepEqual(parseRemote('git@ssh.dev.azure.com:v3/org/project/repo'), {
    origin: 'https://dev.azure.com',
    path: 'org/project/_git/repo',
    host: 'dev.azure.com',
  });
  assert.equal(parseRemote('/srv/git/repo.git'), undefined);
  assert.equal(parseRemote('C:\\repos\\app.git'), undefined, 'a Windows path is not host "C"');
  assert.equal(parseRemote('D:/repos/app.git'), undefined);
  assert.equal(parseRemote('file:///srv/git/repo.git'), undefined);
});

test('guessHostKind uses the host name, then falls back to GitLab', () => {
  const repo = (host: string, path = 'a/b'): WebRepo => ({ origin: `https://${host}`, path, host });
  assert.equal(guessHostKind(repo('github.com')), 'github');
  assert.equal(guessHostKind(repo('github.mycorp.com')), 'github');
  assert.equal(guessHostKind(repo('bitbucket.org')), 'bitbucket');
  assert.equal(guessHostKind(repo('git.mycorp.com', 'scm/PROJ/repo')), 'bitbucket-server');
  assert.equal(guessHostKind(repo('dev.azure.com')), 'azure');
  assert.equal(guessHostKind(repo('codeberg.org')), 'gitea');
  assert.equal(guessHostKind(repo('git.mycorp.com')), 'gitlab');
  assert.equal(guessHostKind(repo('git.mycorp.com'), { 'git.mycorp.com': 'github' }), 'github');
  assert.equal(guessHostKind(repo('git.mycorp.com'), { 'git.mycorp.com': 'nonsense' }), 'gitlab');
});

test('webUrl links files and folders on each kind of site', () => {
  const gh: WebRepo = { origin: 'https://github.com', path: 'o/r', host: 'github.com' };
  const file = { relPath: 'src/a b.ts', isDir: false, ref: 'feat/x' };
  const dir = { relPath: 'src', isDir: true, ref: 'main' };
  const root = { relPath: '', isDir: true, ref: 'main' };
  assert.equal(webUrl(gh, 'github', file), 'https://github.com/o/r/blob/feat/x/src/a%20b.ts');
  assert.equal(webUrl(gh, 'github', dir), 'https://github.com/o/r/tree/main/src');
  assert.equal(webUrl(gh, 'github', root), 'https://github.com/o/r/tree/main');
  assert.equal(webUrl(gh, 'gitlab', file), 'https://github.com/o/r/-/blob/feat/x/src/a%20b.ts');
  assert.equal(webUrl(gh, 'gitlab', dir), 'https://github.com/o/r/-/tree/main/src');
  assert.equal(webUrl(gh, 'bitbucket', dir), 'https://github.com/o/r/src/main/src/');
  assert.equal(webUrl(gh, 'gitea', file), 'https://github.com/o/r/src/branch/feat/x/src/a%20b.ts');
  assert.equal(webUrl(gh, 'gitea', { ...file, ref: 'abc123', isCommit: true }), 'https://github.com/o/r/src/commit/abc123/src/a%20b.ts');

  // Links to the repo itself, and to commits.
  assert.equal(webUrl(gh, 'gitlab', root), 'https://github.com/o/r/-/tree/main');
  assert.equal(webUrl(gh, 'bitbucket', root), 'https://github.com/o/r/src/main');
  assert.equal(webUrl(gh, 'github', { ...file, ref: 'abc123', isCommit: true }), 'https://github.com/o/r/blob/abc123/src/a%20b.ts');
  assert.equal(webUrl(gh, 'github', { ...dir, ref: 'fix/#12' }), 'https://github.com/o/r/tree/fix/%2312/src', 'branch names are encoded');

  const server: WebRepo = { origin: 'https://git.corp', path: 'scm/PROJ/repo', host: 'git.corp' };
  assert.equal(
    webUrl(server, 'bitbucket-server', file),
    'https://git.corp/projects/PROJ/repos/repo/browse/src/a%20b.ts?at=refs%2Fheads%2Ffeat%2Fx',
  );
  const azure: WebRepo = { origin: 'https://dev.azure.com', path: 'org/p/_git/r', host: 'dev.azure.com' };
  assert.equal(webUrl(azure, 'azure', dir), 'https://dev.azure.com/org/p/_git/r?path=%2Fsrc&version=GBmain');
  assert.equal(webUrl(azure, 'azure', { ...file, ref: 'abc', isCommit: true }), 'https://dev.azure.com/org/p/_git/r?path=%2Fsrc%2Fa%20b.ts&version=GCabc');
  assert.equal(
    webUrl(server, 'bitbucket-server', { ...file, ref: 'abc', isCommit: true }),
    'https://git.corp/projects/PROJ/repos/repo/browse/src/a%20b.ts?at=abc',
  );
});
