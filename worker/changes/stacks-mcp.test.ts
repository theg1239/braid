import { describe, expect, it, vi } from 'vitest';
import { handleMcp, type ApiCall } from '../http/mcp';

const input = { title: 'Feature', summary: 'Builds on #51.', base_commit: 'a'.repeat(40), files: [{ path: 'feature.ts', content: 'export const feature = 1;\n' }], depends_on: [51] };
const change = { id: 'ch_0123456789abc', number: 73, revision: 1, title: 'Feature', status: 'open', next: 'Waiting on #51', checks: [], reviews: [], conflicts: [], dependsOn: [{ id: 'ch_1123456789abc', number: 51, status: 'open' }] };
const request = (name: string, args: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
describe('stacked pull requests over MCP', () => {
  it('advertises and passes dependencies through create and update, including clearing them', async () => {
    const call = vi.fn<ApiCall>().mockResolvedValue({ status: 200, data: change });
    const created = await handleMcp(request('create_pull_request', input), call, true);
    expect(JSON.stringify(created)).toContain('Waiting on #51');
    expect(call).toHaveBeenLastCalledWith('POST', '/api/changes', expect.objectContaining({ dependsOn: [51] }), expect.any(String));
    const key = call.mock.calls.at(-1)![3];
    await handleMcp(request('create_pull_request', input), call, true);
    expect(call.mock.calls.at(-1)![3]).toBe(key);
    await handleMcp(request('update_pull_request', { ...input, number: 73, depends_on: [] }), call, true);
    expect(call).toHaveBeenLastCalledWith('POST', `/api/changes/${change.id}/revisions`, expect.objectContaining({ dependsOn: [], previousRevision: 1 }), expect.any(String));
    const listing = await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, call, true);
    expect(JSON.stringify(listing)).toContain('depends_on');
  });
  it.each([[0], ['wrong'], Array(17).fill(1)])('rejects invalid dependencies before calling the API: %j', async depends_on => {
    const call = vi.fn<ApiCall>();
    const result = await handleMcp(request('create_pull_request', { ...input, depends_on }), call, true);
    expect(result).toMatchObject({ result: { isError: true } }); expect(call).not.toHaveBeenCalled();
  });
});

it('exposes restack preconditions, exact retry keys and outdated feedback over MCP', async () => {
  const call = vi.fn<ApiCall>().mockResolvedValue({ status: 200, data: { ...change, status: 'revise', outdated: change.dependsOn } });
  const args = { number: 73, previous_revision: 1, idempotency_key: 'restack-mcp-request' };
  const result = await handleMcp(request('restack_pull_request', args), call, true);
  expect(call).toHaveBeenLastCalledWith('POST', '/api/changes/73/restack', { previousRevision: 1 }, args.idempotency_key);
  expect(JSON.stringify(result)).toContain('#51 changed since this was built');
  await handleMcp(request('restack_pull_request', args), call, true);
  expect(call.mock.calls[0]).toEqual(call.mock.calls[1]);
  for (const invalid of [{ ...args, previous_revision: 0 }, { ...args, idempotency_key: '' }]) {
    call.mockClear();
    expect(await handleMcp(request('restack_pull_request', invalid), call, true)).toMatchObject({ result: { isError: true } });
    expect(call).not.toHaveBeenCalled();
  }
});
