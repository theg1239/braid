import { describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { SECRET_RULES, secretFindings } from './secrets';
import { EMAIL_PATTERN, PRIVATE_KEY_BLOCK, CREDENTIAL_URL, BRAID_CREDENTIAL, redactPublicText } from './privacy';
import { pem } from '../worker/test/pem';

// Repeated starts, almost-credentials and long bodies exercise every regexp globally,
// without the detector's windowing. A worker deadline prevents a regression hanging CI.
const prefixes: Record<string, string[]> = {
  'aws-access-key': ['AKIA', 'AKIA' + 'A'.repeat(15) + '!'],
  'aws-secret-key': ['aws_secret_access_key = ', 'aws_secret_access_key = ' + 'A'.repeat(39) + '!'],
  'github-token': ['ghp_', 'github_pat_' + 'A'.repeat(81) + '!'],
  'gitlab-token': ['glpat-', 'glpat-' + 'A'.repeat(19) + '!'],
  'slack-token': ['xoxb-', 'https://hooks.slack.com/services/TAAAAAAA/BAAAAAAAA/' + 'A'.repeat(23) + '!'],
  'stripe-key': ['sk_live_', 'sk_live_' + 'A'.repeat(23) + '!'],
  'google-api-key': ['AIza', 'AIza' + 'A'.repeat(34) + '!'],
  'openai-key': ['sk-', 'T3BlbkFJ', 'sk-proj-' + 'A'.repeat(40) + 'T3BlbkF' + '!'],
  'anthropic-key': ['sk-ant-api01-', 'sk-ant-api01-' + 'A'.repeat(79) + '!'],
  'npm-token': ['npm_', 'npm_' + 'A'.repeat(35) + '!'],
  'sendgrid-key': ['SG.', 'SG.' + 'A'.repeat(22) + '.' + 'A'.repeat(42) + '!'],
  'braid-token': ['braid_at_', 'braid_agent_' + 'A'.repeat(19) + '!'],
  'private-key': ['-----BEGIN ', '-----BEGIN RSA PRIVATE KEY----!'],
  email: ['a@', 'a@' + 'a.'.repeat(1000) + '!'],
  'private-key-block': [pem('PRIVATE'), '-----BEGIN RSA PRIVATE KEY----!'],
  'credential-url': ['https://', 'https://' + 'a:'.repeat(1000) + '!'],
  'braid-credential': ['braid_at_', 'braid_agent_!'],
};
const megabyte = (prefix: string) => prefix.repeat(Math.ceil(1_000_000 / prefix.length)).slice(0, 1_000_000);
function timings(pattern: RegExp, starts: string[]): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const regexp = new RegExp(workerData.source, workerData.flags.replace('g', '') + 'g');
      const times = workerData.inputs.map(input => {
        const samples = [];
        for (let trial = 0; trial < 5; trial++) {
          const start = performance.now();
          regexp.lastIndex = 0;
          while (regexp.exec(input)) {}
          samples.push(performance.now() - start);
        }
        // The fastest run: backtracking would make every run slow, while a busy machine only slows some.
        return Math.min(...samples);
      });
      parentPort.postMessage(times);
    `, { eval: true, workerData: { source: pattern.source, flags: pattern.flags, inputs: [...starts, 'A', 'A-'].map(megabyte) } });
    const deadline = setTimeout(() => { void worker.terminate(); reject(new Error('1 MB regexp scan exceeded the 2 second worker deadline')); }, 2000);
    worker.once('message', (result: number[]) => { clearTimeout(deadline); void worker.terminate(); resolve(result); });
    worker.once('error', error => { clearTimeout(deadline); void worker.terminate(); reject(error); });
  });
}
describe('linear secret and metadata rules', () => {
  const rules = [...SECRET_RULES, { id: 'email', pattern: EMAIL_PATTERN }, { id: 'private-key-block', pattern: PRIVATE_KEY_BLOCK },
    { id: 'credential-url', pattern: CREDENTIAL_URL }, { id: 'braid-credential', pattern: BRAID_CREDENTIAL }];
  for (const { id, pattern } of rules) it(`${id}: globally scans hostile 1 MB prefixes and near misses in low tens of milliseconds`, async () => {
    const samples = await timings(pattern, prefixes[id]);
    console.log(`${id}: slowest input ${Math.max(...samples).toFixed(1)} ms / MB`);
    expect(Math.max(...samples)).toBeLessThan(60);
  });
  it('bounds end-to-end detection and metadata redaction on repeated sk- starts', () => {
    const text = megabyte('sk-');
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      expect(secretFindings([{ path: 'hostile.txt', before: null, after: text }])).toEqual([]);
      expect(redactPublicText(text)).toBe(text);
      samples.push(performance.now() - start);
    }
    console.log(`1 MB detection + redaction, fastest of three: ${Math.min(...samples).toFixed(1)} ms`);
    expect(Math.min(...samples)).toBeLessThan(100);
  });
});
