import { createServer, type Server } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComposeReader } from '../repositories/compose';

/** A real bare repository served by `git http-backend`, with an Artifacts-shaped object reader. */
export async function startGitServer() {
  const root = mkdtempSync(join(tmpdir(), 'braid-git-test-'));
  const requests: { path: string; bytes: number }[] = [];
  execFileSync('git', ['init', '--bare', '--initial-branch=main', join(root, 'repo.git')], { stdio: 'ignore' });
  let inputs = 0;
  const identity = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' };
  /**
   * Git on the fixture repository. Input arrives from a file rather than a pipe, which stalled under a full parallel
   * run, and a Git that still stalls fails its test within a minute instead of holding up every other one.
   */
  const run = (args: string[], input?: string | Buffer, env: NodeJS.ProcessEnv = identity) => {
    const file = input === undefined ? null : join(root, `input-${++inputs}`);
    if (file) writeFileSync(file, input!);
    const stdin = file ? openSync(file, 'r') : 'ignore';
    try { return execFileSync('git', ['--git-dir', join(root, 'repo.git'), ...args], { stdio: [stdin, 'pipe', 'pipe'], env, timeout: 60_000, maxBuffer: 1 << 28 }); }
    finally { if (typeof stdin === 'number') closeSync(stdin); if (file) rmSync(file); }
  };
  run(['config', 'http.receivepack', 'true']);
  // Fixtures write thousands of loose objects; Git must not start housekeeping in the middle of a test.
  run(['config', 'gc.auto', '0']);
  run(['config', 'maintenance.auto', 'false']);
  const native = (args: string[], input?: string | Buffer) => run(args, input).toString('utf8');
  const raw = (args: string[]) => run(args);
  /** Commits as Artifacts decodes them, newest first along first parents: one `git log` for any number. */
  const commits = (args: string[]): ArtifactsCommitMetadata[] => native(['log', '--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B%x1e', ...args])
    .split('\x1e').map(record => record.replace(/^\n/, '')).filter(Boolean).map(record => {
      const [hash, treeHash, parents, authorName, authorEmail, authoredAt, committerName, committerEmail, committedAt, message] = record.split('\0');
      return { hash, treeHash, parents: parents ? parents.split(' ') : [], author: { name: authorName, email: authorEmail }, committer: { name: committerName, email: committerEmail },
        authoredAt: Number(authoredAt), committedAt: Number(committedAt), message: message.replace(/\n$/, '') };
    });
  /** Artifacts decodes commit objects itself, so a shallow copy's tip keeps the parents it lacks, which `git log` hides. */
  const decoded = (found: ArtifactsCommitMetadata[]) => {
    let grafted: Set<string>;
    try { grafted = new Set(readFileSync(join(root, 'repo.git', 'shallow'), 'utf8').split('\n').filter(Boolean)); } catch { return found; }
    return found.map(commit => grafted.has(commit.hash) ? { ...commit, parents: native(['cat-file', 'commit', commit.hash]).split('\n\n', 1)[0].split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7)) } : commit);
  };
  const repository: Omit<ComposeReader, 'readCommit'> & { readCommit(hash: string): Promise<ArtifactsCommitMetadata | null>; log(options: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactsCommitMetadata[]> } = {
    async readCommit(hash) {
      try { return decoded(commits(['-1', '--no-walk', hash]))[0] ?? null; } catch { return null; }
    },
    async log({ ref = 'HEAD', limit = 50, offset = 0 }) {
      // Artifacts follows first parents while their objects exist; Git stops at its shallow list, so the walk resumes past it.
      const present = (hash: string) => { try { native(['cat-file', '-e', hash]); return true; } catch { return false; } };
      try {
        const found: ArtifactsCommitMetadata[] = [];
        for (let next: string | undefined = ref; next && found.length < offset + limit;) {
          const page = decoded(commits(['--first-parent', `--max-count=${offset + limit - found.length}`, next]));
          found.push(...page);
          const parent = page.at(-1)?.parents[0];
          next = parent && present(parent) ? parent : undefined;
        }
        return found.slice(offset, offset + limit);
      } catch { return []; }
    },
    async readTree(hash) {
      return native(['ls-tree', '-z', hash]).split('\0').filter(Boolean).map(line => {
        const tab = line.indexOf('\t'), [mode, , hash] = line.slice(0, tab).split(' ');
        // Match Artifacts' classifications and unpadded tree modes, not git ls-tree's.
        const type: ArtifactsTreeEntry['type'] = mode === '040000' ? 'tree' : mode === '100755' ? 'exec' : mode === '120000' ? 'symlink' : mode === '160000' ? 'gitlink' : 'blob';
        return { mode: mode === '040000' ? '40000' : mode, type, hash, name: line.slice(tab + 1) };
      });
    },
    async readBlob(hash) {
      try { return new Blob([new Uint8Array(raw(['cat-file', 'blob', hash]))]); } catch { return null; }
    },
  };
  /** Commits a complete file map (null deletes) on top of `parent` and returns the new commit, by `author` when given. */
  const commitTree = (files: Record<string, string | null>, parent?: string, message = 'Fixture', author = { name: 'Test', email: 'test@example.test' }) => {
    const work = mkdtempSync(join(tmpdir(), 'braid-git-work-'));
    const env = { ...process.env, GIT_INDEX_FILE: join(work, 'index'), GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
    const git = (args: string[], input?: string) => run(args, input, env).toString('utf8');
    if (parent) git(['read-tree', parent]); else git(['read-tree', '--empty']);
    // --index-info works without a work tree; mode 0 removes an entry.
    const info = Object.entries(files).map(([path, content]) => content === null ? `0 ${'0'.repeat(40)}\t${path}` : `100644 ${git(['hash-object', '-w', '--stdin'], content).trim()}\t${path}`);
    if (info.length) git(['update-index', '--index-info'], info.join('\n') + '\n');
    const tree = git(['write-tree']).trim();
    const commit = git(['commit-tree', tree, ...(parent ? ['-p', parent] : [])], `${message}\n`).trim();
    rmSync(work, { recursive: true, force: true });
    return commit;
  };
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const received = { path: url.pathname + url.search, bytes: 0 };
    requests.push(received);
    request.on('data', chunk => { received.bytes += chunk.length; });
    const child = spawn('git', ['http-backend'], { env: {
      ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method!,
      CONTENT_TYPE: request.headers['content-type'] || '', CONTENT_LENGTH: request.headers['content-length'] || '',
      // As a web server hands them to the CGI: protocol v2 when asked for, and compressed request bodies.
      HTTP_GIT_PROTOCOL: String(request.headers['git-protocol'] ?? ''), HTTP_CONTENT_ENCODING: String(request.headers['content-encoding'] ?? ''),
      REMOTE_USER: 'braid-test',
    } });
    const chunks: Buffer[] = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.resume();
    child.on('close', () => {
      const output = Buffer.concat(chunks), separator = output.indexOf('\r\n\r\n');
      if (separator < 0) { response.writeHead(500); response.end('Git CGI failed'); return; }
      let status = 200;
      for (const header of output.subarray(0, separator).toString().split('\r\n')) {
        const colon = header.indexOf(':'); if (colon < 0) continue;
        const name = header.slice(0, colon), value = header.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
        else response.setHeader(name, value);
      }
      response.writeHead(status); response.end(output.subarray(separator + 4));
    });
    request.pipe(child.stdin);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test Git server did not start.');
  return {
    root, requests, native, repository, commitTree,
    remote: `http://127.0.0.1:${address.port}/repo.git`,
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); },
  };
}
