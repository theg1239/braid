import type { BraidEnv } from '../env';
import { publicPerson } from '../repositories/provenance';
import { redactPublicText } from '../../shared/privacy';
import type { RepositoryTree } from '../../shared/repository';

/** Public metadata omits Braid credentials, account addresses and connection configuration. Git content and paths are served verbatim; only Braid-authored metadata is redacted. */
const CONTENT_FIELDS = new Set(['before', 'after', 'content', 'path', 'paths', 'beforePath', 'afterPath']);
const PRIVATE_FIELDS = /(?:token|^secret$|client.?secret|secret.?key|private.?key|api.?key|password|credential|authorization|connection.?digest|webhook|hook.?url)|^(?:email|hooks|members|invites|identity|remote)$/i;
export function publicMetadata(value: unknown, contentFields = CONTENT_FIELDS, paths = false): unknown {
  if (typeof value === 'string') return redactPublicText(value);
  if (Array.isArray(value)) return value.map(item => publicMetadata(item, contentFields));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => paths || !PRIVATE_FIELDS.test(key)).map(([key, item]) => [key, !paths && contentFields.has(key) ? item : publicMetadata(item, contentFields, !paths && key === 'files')]));
}
export async function publicResponse(response: Response, path: string, env?: BraidEnv): Promise<Response> {
  response = new Response(response.body, response);
  if (!response.headers.get('content-type')?.includes('application/json')) return response;
  // Repository files, directory names, downloads and policy/instructions are owner's published Git content.
  if (['/api/repository', '/api/repository/tree'].includes(path) && response.ok) return response;
  if (path === '/api/repository/tree/commits' && response.ok) {
    const tree = await response.json() as RepositoryTree;
    return Response.json({ ...tree, entries: tree.entries.map(item => ({ ...item,
      ...(item.lastCommit ? { lastCommit: { ...item.lastCommit, title: redactPublicText(item.lastCommit.title) } } : {}) })) }, response);
  }
  const data = await response.json() as Record<string, unknown>;
  // Public commit subjects and messages are metadata, including co-author emails and pasted credentials.
  const contentFields = ['/api/policy', '/api/instructions'].includes(path) ? new Set([...CONTENT_FIELDS, 'policy', 'instructions']) : CONTENT_FIELDS;
  if (path === '/api/state' && response.ok) {
    // The tree/file API supplies code; the snapshot's cache is not a second publication surface.
    data.files = {};
    const capabilities = data.capabilities as Record<string, unknown>;
    capabilities.canWrite = false;
    capabilities.authenticated = false;
  }
  if (env) {
    const ids = new Set<string>();
    const visit = (value: unknown, person = false, paths = false) => {
      if (Array.isArray(value)) value.forEach(item => visit(item));
      else if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
          if (person && key === 'id' && typeof item === 'string' && item.startsWith('user:')) ids.add(item);
          if (paths || !contentFields.has(key)) visit(item, !paths && (key === 'author' || key === 'owner'), !paths && key === 'files');
        }
      }
    };
    visit(data);
    const mapping = new Map(await Promise.all([...ids].map(async id => {
      const person = await publicPerson(env, id);
      return [id, person ? `person:${person}` : undefined] as const;
    })));
    const map = (value: unknown, person = false, paths = false): unknown => {
      if (Array.isArray(value)) return value.map(item => map(item));
      if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
        if (person && key === 'id' && typeof item === 'string' && item.startsWith('user:')) return mapping.get(item) ? [[key, mapping.get(item)]] : [];
        return [[key, !paths && contentFields.has(key) ? item : map(item, !paths && (key === 'author' || key === 'owner'), !paths && key === 'files')]];
      }));
      return value;
    };
    return Response.json(publicMetadata(map(data), contentFields), response);
  }
  return Response.json(publicMetadata(data, contentFields), response);
}
