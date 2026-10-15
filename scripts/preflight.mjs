import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Local checks only; never send or print the contents of the secrets file.
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Provide a value for ${name}.`);
  return args[index + 1];
}
function readEnv(path) { return path ? parseEnv(readFileSync(path, 'utf8')) : {}; }
const configuration = { ...readEnv(option('--env-file')), ...process.env };
const secrets = readEnv(option('--secrets-file'));
const problems = [];
const requireValue = name => { if (!configuration[name]?.trim()) problems.push(`Set ${name}.`); };
for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'BRAID_WORKER_NAME', 'BRAID_PUBLIC_ORIGIN', 'BRAID_GITHUB_CLIENT_ID', 'BRAID_EMAIL_FROM']) requireValue(name);
if (configuration.BRAID_AUTH_MODE !== 'github') problems.push('Set BRAID_AUTH_MODE=github for public accounts with GitHub, email and passkeys.');
if (!['true', 'false'].includes(configuration.BRAID_SIGNUP_ENABLED)) problems.push('Set BRAID_SIGNUP_ENABLED explicitly; use false while verifying providers.');
let origin;
try {
  origin = new URL(configuration.BRAID_PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error();
} catch { problems.push('BRAID_PUBLIC_ORIGIN must be an HTTPS origin without a path, query or credentials.'); }
if (configuration.BRAID_WORKER_NAME && !/^[a-z][a-z0-9-]{1,62}$/.test(configuration.BRAID_WORKER_NAME)) problems.push('BRAID_WORKER_NAME must contain 2–63 lowercase letters, digits or hyphens.');
if (configuration.BRAID_EMAIL_FROM && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(configuration.BRAID_EMAIL_FROM)) problems.push('BRAID_EMAIL_FROM must be a sender address verified in Cloudflare Email Service.');
for (const [name, minimum] of [['SESSION_SECRET', 32], ['GITHUB_CLIENT_SECRET', 1]]) {
  const value = secrets[name] || configuration[name];
  if (!value || value.length < minimum || /^(?:replace|your[-_]|changeme|example)/i.test(value)) problems.push(`Provide ${name} in the private secrets file${minimum > 1 ? ` with at least ${minimum} characters` : ''}.`);
}
if (secrets.ADMIN_TOKEN) problems.push('Use a separate secrets file for public accounts; omit the standalone ADMIN_TOKEN.');
const appFields = ['BRAID_GITHUB_APP_ID', 'BRAID_GITHUB_APP_SLUG', 'BRAID_GITHUB_APP_CLIENT_ID'];
if (appFields.some(name => configuration[name]) || secrets.GITHUB_APP_CLIENT_SECRET || secrets.GITHUB_APP_PRIVATE_KEY) {
  for (const name of appFields) requireValue(name);
  if (!/^\d+$/.test(configuration.BRAID_GITHUB_APP_ID || '')) problems.push('BRAID_GITHUB_APP_ID must be a numeric GitHub App ID.');
  if (!/^[a-z0-9-]+$/.test(configuration.BRAID_GITHUB_APP_SLUG || '')) problems.push('BRAID_GITHUB_APP_SLUG must be the registered GitHub App slug.');
  for (const name of ['GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY']) if (!secrets[name]?.trim()) problems.push(`Provide ${name} in the private secrets file.`);
  if (configuration.BRAID_GITHUB_WEBHOOKS === '1' && (secrets.GITHUB_APP_WEBHOOK_SECRET ?? '').length < 20) problems.push('Provide GITHUB_APP_WEBHOOK_SECRET (at least 20 characters) in the private secrets file, matching the App\'s webhook secret.');
}
if (configuration.BRAID_SANDBOX_IMAGE && !/^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(configuration.BRAID_SANDBOX_IMAGE)) problems.push('BRAID_SANDBOX_IMAGE must be a digest-pinned Cloudflare managed registry image.');
for (const [name, maximum] of [['BRAID_DAILY_TASK_LIMIT', 100], ['BRAID_GLOBAL_DAILY_TASK_LIMIT', 10000]]) {
  if (configuration[name] !== undefined && (!/^\d+$/.test(configuration[name]) || Number(configuration[name]) < 1 || Number(configuration[name]) > maximum)) problems.push(`${name} must be an integer between 1 and ${maximum}.`);
}
if (problems.length) {
  console.error(`Public deployment configuration is incomplete:\n${problems.map(problem => `- ${problem}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Configuration checks passed for ${configuration.BRAID_WORKER_NAME}.\nGitHub callback: ${origin.origin}/api/auth/github/callback\nPasskey relying party: ${origin.hostname}\nNew team signup: ${configuration.BRAID_SIGNUP_ENABLED}\nVerify GitHub sign-in, real email delivery and a browser passkey before opening signup. These checks do not contact either provider.`);
}
