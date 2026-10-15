/** Shared assertions for the canary and local mirror E2E. No credentials or writes. */
export class MirrorFailure extends Error {}
export const need = (condition, message) => { if (!condition) throw new MirrorFailure(message); };
export const PUBLIC_MIRROR = 'octocat/Hello-World';
export const NOT_FOUND = "Not found on GitHub. If it's private, sign in with GitHub to see it.";
export const NOT_FOUND_CODE = 'github_not_found_or_private';
export const PRIVATE = NOT_FOUND;
export const RESERVED = ['api', 'explore'];
export const isSha = value => typeof value === 'string' && /^[a-f\d]{40}$/i.test(value);

export function validateMirror(value, repository = PUBLIC_MIRROR) {
  need(typeof value?.workspaceId === 'string' && value.workspaceId.length > 0, 'resolution has no workspaceId');
  need(`${value.owner?.slug}/${value.repo?.slug}`.toLowerCase() === repository.toLowerCase(), 'resolved to a different owner/repository');
  need(value.visibility === 'public' && value.canWrite === false, 'signed-out mirror must be public and read-only');
  const m = value.mirror;
  need(m && typeof m.source === 'string', 'resolution has no mirror.source');
  let source;
  try { source = new URL(m.source); } catch { throw new MirrorFailure('mirror.source is not a GitHub URL'); }
  need(source.protocol === 'https:' && source.host === 'github.com' && !source.username && !source.password && !source.search && !source.hash && source.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '').toLowerCase() === `/${repository.toLowerCase()}`, 'mirror.source does not name the GitHub repository');
  need(typeof m.importing === 'boolean', 'mirror.importing must be boolean');
  need(typeof m.claimable === 'boolean', 'mirror.claimable must be boolean');
  need(m.claimable === false, 'signed-out visitor must not be able to claim an owner');
  need(m.syncedAt === null || typeof m.syncedAt === 'string' && Number.isFinite(Date.parse(m.syncedAt)), 'mirror.syncedAt must be null or a timestamp');
  return value;
}

/** Parse pkt-lines instead of finding an arbitrary SHA in the advertisement. */
export function advertisedHead(bytes) {
  let offset = 0, head, branch, branchHeads = new Map(), service = false;
  while (offset < bytes.length) {
    need(offset + 4 <= bytes.length, 'GitHub advertisement has a truncated pkt-line length');
    const prefix = bytes.toString('ascii', offset, offset + 4);
    need(/^[\da-f]{4}$/i.test(prefix), 'GitHub advertisement has an invalid pkt-line length');
    const size = Number.parseInt(prefix, 16);
    offset += 4;
    if (size === 0) continue;
    need(size >= 4 && offset + size - 4 <= bytes.length, 'GitHub advertisement has a truncated pkt-line');
    const line = bytes.toString('utf8', offset, offset + size - 4).replace(/\n$/, '');
    offset += size - 4;
    if (line === '# service=git-upload-pack') { service = true; continue; }
    const [ref, capabilities = ''] = line.split('\0', 2);
    const match = ref.match(/^([a-f\d]{40}) (HEAD|refs\/heads\/.+)$/i);
    if (match?.[2] === 'HEAD') head = match[1];
    else if (match) branchHeads.set(match[2], match[1]);
    const symref = capabilities.match(/(?:^| )symref=HEAD:refs\/heads\/([^ ]+)(?: |$)/);
    if (symref) branch = symref[1];
  }
  need(service && isSha(head) && branch && branchHeads.get(`refs/heads/${branch}`) === head, 'GitHub did not advertise a matching HEAD and default branch');
  return { head, branch };
}

export async function githubReference(repository = PUBLIC_MIRROR, { signal, onRequest = () => {} } = {}) {
  need(/^[\w.-]+\/[\w.-]+$/.test(repository), 'invalid GitHub fixture address');
  async function get(url, cap) {
    onRequest();
    const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]);
    let response;
    try {
      response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: deadline, headers: { 'User-Agent': 'braid-mirror-verification', Accept: '*/*' } });
      need(response.status === 200, `GitHub reference HTTP ${response.status}: ${new URL(url).pathname}`);
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) { length += chunk.length; need(length <= cap, 'GitHub reference exceeds its size limit'); chunks.push(chunk); }
      return Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof MirrorFailure) throw error;
      throw new MirrorFailure(`GitHub reference ${deadline.aborted ? 'exceeded 20s deadline' : 'network/body read failed'}: ${new URL(url).pathname}`);
    } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  }
  const advertised = advertisedHead(await get(`https://github.com/${repository}.git/info/refs?service=git-upload-pack`, 32 * 1024 * 1024));
  // Hello-World intentionally has an extensionless README. Read its actual bytes
  // at the independently advertised SHA; do not trust Braid to choose the oracle.
  const readme = (await get(`https://raw.githubusercontent.com/${repository}/${advertised.head}/README`, 1024 * 1024)).toString('utf8');
  need(readme.trim().length > 0, 'GitHub fixture README is empty');
  return { ...advertised, path: 'README', readme };
}
