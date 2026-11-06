/** Kinds of git hosting site, which differ in how their web links are built. */
export type HostKind = 'github' | 'gitlab' | 'bitbucket' | 'bitbucket-server' | 'azure' | 'gitea';

export const HOST_KINDS: readonly HostKind[] = ['github', 'gitlab', 'bitbucket', 'bitbucket-server', 'azure', 'gitea'];

export interface WebRepo {
  /** Scheme, host and port of the website, such as `https://github.com`. */
  origin: string;
  /** Repo path on the site without `.git`, such as `owner/repo`. */
  path: string;
  host: string;
}

/**
 * Turns a remote URL (`git@host:owner/repo.git`, `ssh://git@host:2222/owner/repo.git`,
 * `https://user@host/owner/repo.git`) into the repo's address on the website.
 * SSH ports are dropped, since the website doesn't use them.
 */
export function parseRemote(remote: string): WebRepo | undefined {
  const url = remote.trim();
  // A Windows path such as C:\repos\app.git is a local remote, not host "C" (git reads it the same way).
  if (/^[a-z]:[\\/]/i.test(url)) return undefined;
  let scheme = 'https';
  let host: string;
  let port = '';
  let repoPath: string;

  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(url);
  const full = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.+)$/i.exec(url);
  if (full) {
    const protocol = full[1].toLowerCase();
    if (protocol === 'http' || protocol === 'https') {
      scheme = protocol;
      port = full[3] ? `:${full[3]}` : '';
    } else if (protocol !== 'ssh' && protocol !== 'git' && protocol !== 'git+ssh') {
      return undefined;
    }
    host = full[2];
    repoPath = full[4];
  } else if (scp) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    return undefined;
  }

  repoPath = repoPath.replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+/, '');
  if (!repoPath) return undefined;
  // Azure DevOps SSH remotes look like ssh.dev.azure.com:v3/org/project/repo.
  if (host === 'ssh.dev.azure.com' && repoPath.startsWith('v3/')) {
    const [org, project, repo] = repoPath.slice(3).split('/');
    return { origin: 'https://dev.azure.com', path: `${org}/${project}/_git/${repo}`, host: 'dev.azure.com' };
  }
  return { origin: `${scheme}://${host}${port}`, path: repoPath, host };
}

/** Guesses the kind of site from its host name and path. Self-hosted sites default to GitLab. */
export function guessHostKind(repo: WebRepo, configured: Readonly<Record<string, string>> = {}): HostKind {
  const set = configured[repo.host] ?? configured[repo.host.toLowerCase()];
  if (set && (HOST_KINDS as readonly string[]).includes(set)) return set as HostKind;
  const host = repo.host.toLowerCase();
  if (host === 'github.com' || host.includes('github')) return 'github';
  if (host === 'bitbucket.org') return 'bitbucket';
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) return 'azure';
  if (/(^|\/)scm\//.test(repo.path)) return 'bitbucket-server';
  if (host.includes('bitbucket')) return 'bitbucket-server';
  if (host.includes('gitea') || host.includes('codeberg') || host.includes('forgejo')) return 'gitea';
  return 'gitlab';
}

export interface WebLinkTarget {
  /** Path inside the repo with forward slashes; empty for the repo itself. */
  relPath: string;
  isDir: boolean;
  /** Branch name or commit to link to. */
  ref: string;
  /** Whether `ref` is a commit rather than a branch. */
  isCommit?: boolean;
}

/** The web address of a file or folder at a branch or commit. */
export function webUrl(repo: WebRepo, kind: HostKind, target: WebLinkTarget): string {
  const base = `${repo.origin}/${repo.path}`;
  const rel = target.relPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const ref = target.ref.split('/').map(encodeURIComponent).join('/');
  const tail = rel ? `/${rel}` : '';

  switch (kind) {
    case 'github':
      return rel ? `${base}/${target.isDir ? 'tree' : 'blob'}/${ref}${tail}` : `${base}/tree/${ref}`;
    case 'gitlab':
      return `${base}/-/${rel && !target.isDir ? 'blob' : 'tree'}/${ref}${tail}`;
    case 'gitea':
      return `${base}/src/${target.isCommit ? 'commit' : 'branch'}/${ref}${tail}`;
    case 'bitbucket':
      return `${base}/src/${ref}${tail}${target.isDir && rel ? '/' : ''}`;
    case 'bitbucket-server': {
      // https://host/scm/PROJ/repo -> https://host/projects/PROJ/repos/repo/browse/path?at=...
      const parts = repo.path.replace(/(^|\/)scm\//, '$1').split('/');
      const name = parts.pop()!;
      const project = parts.pop()!;
      const prefix = parts.length ? `${parts.join('/')}/` : '';
      const at = target.isCommit ? target.ref : `refs/heads/${target.ref}`;
      return `${repo.origin}/${prefix}projects/${project}/repos/${name}/browse${tail}?at=${encodeURIComponent(at)}`;
    }
    case 'azure': {
      const version = `${target.isCommit ? 'GC' : 'GB'}${target.ref}`;
      return `${base}?path=${encodeURIComponent(`/${target.relPath}`)}&version=${encodeURIComponent(version)}`;
    }
  }
}
