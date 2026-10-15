import { expect, it } from 'vitest';
import { RequestJournal } from './operations';
import { storageFixture } from '../test/storage';
it('replays a durable receipt only for the same actor and operation', async () => {
  const { storage } = storageFixture(), journal = new RequestJournal(storage.sql);
  const request = new Request('https://braid.example/api/missions', { method: 'POST', headers: { 'idempotency-key': 'test-request-key-123', 'x-braid-actor': 'owner' } });
  const receipt = await journal.read(request, { title: 'A' }, true);
  journal.save(receipt, 202, { missionId: 'one' });
  const replay = await new RequestJournal(storage.sql).read(request, { title: 'A' }, true);
  expect(JSON.parse(replay!.body!)).toEqual({ missionId: 'one' });
  await expect(journal.read(request, { title: 'B' }, true)).rejects.toThrow(/different operation/);
  const other = new Request(request); other.headers.set('x-braid-actor', 'other');
  await expect(journal.read(other, { title: 'A' }, true)).rejects.toThrow(/different operation/);
  await expect(journal.read(new Request('https://braid.example'), {}, true)).rejects.toThrow(/Idempotency-Key/);
});
