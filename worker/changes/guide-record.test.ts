import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { GUIDE_MODEL, guideError, guideRequest, parseGuide, prepareGuide } from './guide';
import { recordedGuideInput, type GuideRecording } from './guide-recording';
import type { ChangeGuide } from '../../shared/guide';
import * as v from 'valibot';

/** Explicit, one-off real inference. Normal tests never call Workers AI or write the recording.
 * BRAID_RECORD_GUIDES=1 npm test -- worker/changes/guide-record.test.ts
 * Uses the authenticated cf CLI; it needs no model endpoint or credential in Braid's public API.
 */
it.skipIf(process.env.BRAID_RECORD_GUIDES !== '1')('records real Workers AI guides for every tour revision', async () => {
  const run = promisify(execFile), file = new URL('./recorded.json', import.meta.url);
  const recorded = JSON.parse(await readFile(file, 'utf8')) as GuideRecording;
  // An explicit editorial correction regenerates only the named revisions, still entirely through the model.
  const feedback = process.env.BRAID_GUIDE_FEEDBACK_FILE ? v.parse(v.record(v.string(), v.pipe(v.string(), v.maxLength(1600))), JSON.parse(await readFile(process.env.BRAID_GUIDE_FEEDBACK_FILE, 'utf8'))) : {};
  const folder = process.env.BRAID_GUIDE_RECORD_DIR || await mkdtemp(join(tmpdir(), 'braid-guides-'));
  const identity = (recording: GuideRecording) => createHash('sha256').update(JSON.stringify([recording.changes.map(change => [change.id, change.revision, change.title, change.summary, change.intent, change.rationale]), recording.diffs])).digest('hex');
  const original = identity(recorded), results: Record<string, ChangeGuide> = { ...recorded.guides };
  const jobs = recorded.changes.flatMap(change => Array.from({ length: change.revision }, (_, index) => ({ change, revision: index + 1 })));
  console.log(`Recording ${jobs.length} revisions with ${GUIDE_MODEL}; raw results: ${folder}`);
  let next = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (next < jobs.length) {
      const { change, revision } = jobs[next++], key = `${change.id}:${revision}`;
      if (!feedback[key] && results[key]?.status === 'ready' && results[key].generatedBy === GUIDE_MODEL) continue;
      const input = prepareGuide(recordedGuideInput(recorded, change, revision));
      // Resume validated offline results after an interrupted recording without spending another inference.
      try {
        if (feedback[key]) throw new Error('An editorial correction was requested.');
        const kept = JSON.parse(await readFile(join(folder, `${key}-guide.json`), 'utf8')) as ChangeGuide;
        results[key] = parseGuide({ before: kept.before, after: kept.after, chapters: kept.chapters.map(chapter => ({ ...chapter,
          hunks: chapter.files.flatMap(file => file.hunks.map(hunk => ({ path: file.path, newStart: hunk.newStart, newLines: hunk.newLines }))) })) }, input, revision);
        continue;
      } catch { /* Missing or invalid output is generated again, never used as a guide. */ }
      let error: string | undefined = feedback[key];
      for (let attempt = 1; attempt <= 2; attempt++) {
        const request = join(folder, `${key}-${attempt}-request.json`), response = join(folder, `${key}-${attempt}-response.json`);
        await writeFile(request, JSON.stringify(guideRequest(input, error)));
        try {
          const { stdout } = await run(process.execPath, ['node_modules/cf/bin/cf', 'ai', 'run', GUIDE_MODEL, '--body', `@${request}`], { timeout: 120_000, maxBuffer: 2_000_000 });
          await writeFile(response, stdout);
          results[key] = parseGuide(JSON.parse(stdout), input, revision);
          console.log(`Recorded #${change.number} revision ${revision}, ${input.hunks.length} hunks, ${results[key].chapters.length} chapters.`);
          break;
        } catch (caught) {
          error = guideError(caught);
          console.log(`#${change.number} revision ${revision}, attempt ${attempt}: ${error}`);
          if (attempt === 2) results[key] = { status: 'failed', revision, generatedBy: GUIDE_MODEL, chapters: [], attributes: input.attributes, error };
        }
      }
      await writeFile(join(folder, `${key}-guide.json`), JSON.stringify(results[key], null, 2));
    }
  }));
  const current = JSON.parse(await readFile(file, 'utf8')) as GuideRecording;
  expect(identity(current), 'Recording changed concurrently; validated outputs remain in the artifact folder.').toBe(original);
  await writeFile(file, JSON.stringify({ ...current, guides: results, guideRecording: { model: GUIDE_MODEL, generatedAt: new Date().toISOString(), source: 'Workers AI', revisions: jobs.length } }));
  expect(Object.keys(results)).toHaveLength(jobs.length);
  expect(Object.entries(results).filter(([, guide]) => guide.status !== 'ready').map(([key, guide]) => [key, guide.error])).toEqual([]);
}, 30 * 60_000);
