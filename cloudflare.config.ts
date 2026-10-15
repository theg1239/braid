import { defineConfig, defineContainer, bindings, exports } from 'cf/config';

const name = process.env.BRAID_WORKER_NAME || 'braid-git';
const authMode = process.env.BRAID_AUTH_MODE || 'owner-key';
const workflowName = name === 'braid-git' ? 'braid-missions' : `${name}-missions`;
const verifyWorkflowName = `${name}-verifications`;
const namespace = process.env.BRAID_ARTIFACTS_NAMESPACE || (name === 'braid-git' ? 'braid' : name);
const sandboxImage = process.env.BRAID_SANDBOX_IMAGE;
if (sandboxImage && !/^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(sandboxImage)) throw new Error('BRAID_SANDBOX_IMAGE must pin a Cloudflare managed registry image by digest.');
const sandbox = defineContainer({ name: `${name}-agents`, schedulingPolicy: 'durable-object', images: { agent: sandboxImage ? { reference: sandboxImage } : { dockerfile: './sandbox/Dockerfile', buildContext: '.' } }, ssh: { enabled: false }, observability: { enabled: false } });
export default defineConfig(({ mode }) => {
// Local development needs Docker only when it exercises sandboxes; the recorded example never does.
const containers = mode !== 'development' || process.env.BRAID_DEV_CONTAINERS === '1';
return {
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  ...(containers ? { containers: [sandbox] } : {}),
  worker: {
    name,
    entrypoint: './worker/index.ts',
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    // Pages stream URL-derived social metadata through the Worker; static files still bypass it.
    assets: { notFoundHandling: 'single-page-application', runWorkerFirst: ['/*', '!/assets/*', '!/fonts/*', '!/cli/*', '!/source/*', '!/favicon.svg', '!/boot.js', '!/og.png', '!/apple-touch-icon.png', '!/scale-evidence.txt',
      // Vite serves development modules itself; the page handler would answer them with HTML.
      ...(mode === 'development' ? ['!/src/*', '!/shared/*', '!/@*', '!/node_modules/*', '!/.cloudflare/*'] : []),
    ] },
    env: {
      ASSETS: bindings.assets(),
      IP_LIMITER: bindings.rateLimit({ namespace: process.env.BRAID_IP_LIMIT_NAMESPACE || '73101', simple: { limit: 3000, period: 60 } }),
      // All nonmember reads, including conditional polls, share 300/minute per network.
      ANONYMOUS_LIMITER: bindings.rateLimit({ namespace: process.env.BRAID_ANONYMOUS_LIMIT_NAMESPACE || '73103', simple: { limit: 300, period: 60 } }),
      // One expensive public read/second bounds bulk diffs, downloads, upload-pack and cache builds.
      PUBLIC_EXPENSIVE_LIMITER: bindings.rateLimit({ namespace: process.env.BRAID_PUBLIC_EXPENSIVE_LIMIT_NAMESPACE || '73104', simple: { limit: 60, period: 60 } }),
      AGENT_LIMITER: bindings.rateLimit({ namespace: process.env.BRAID_AGENT_LIMIT_NAMESPACE || '73102', simple: { limit: 600, period: 60 } }),
      WORKSPACES: bindings.durableObject({ worker: name, exportName: 'Workspace' }),
      SECURITY: bindings.durableObject({ worker: name, exportName: 'Security' }),
      DIRECTORY: bindings.durableObject({ worker: name, exportName: 'Directory' }),
      CHANGES: bindings.durableObject({ worker: name, exportName: 'ChangeShard' }),
      TRUNKS: bindings.durableObject({ worker: name, exportName: 'Trunk' }),
      PATHS: bindings.durableObject({ worker: name, exportName: 'PathIndex' }),
      SWARMS: bindings.durableObject({ worker: name, exportName: 'Swarm' }),
      GITHUB_REPOS: bindings.durableObject({ worker: name, exportName: 'GitHubRepo' }),
      MISSIONS: bindings.workflow({ name: workflowName, worker: name, exportName: 'MissionWorkflow' }),
      VERIFICATIONS: bindings.workflow({ name: verifyWorkflowName, worker: name, exportName: 'VerifyWorkflow' }),
      ARTIFACTS: bindings.artifacts({ namespace }),
      AI: bindings.ai(),
      ...(authMode === 'owner-key' ? { ADMIN_TOKEN: bindings.secret() } : {}),
      LIVE_ENABLED: bindings.text(mode === 'development' && process.env.BRAID_REMOTE_DEV !== '1' ? 'false' : 'true'),
      AI_MODEL: bindings.text('@cf/zai-org/glm-5.3-flash'),
      REVIEW_MODEL: bindings.text(process.env.BRAID_REVIEW_MODEL || '@cf/zai-org/glm-5.3-flash'),
      ARTIFACTS_NAMESPACE: bindings.text(namespace),
      AUTH_MODE: bindings.text(authMode),
      ACCESS_TEAM_DOMAIN: bindings.text(process.env.BRAID_ACCESS_TEAM_DOMAIN || ''),
      ACCESS_AUD: bindings.text(process.env.BRAID_ACCESS_AUD || ''),
      ACCESS_OWNER_EMAILS: bindings.text(process.env.BRAID_ACCESS_OWNER_EMAILS || ''),
      DAILY_TASK_LIMIT: bindings.text(process.env.BRAID_DAILY_TASK_LIMIT || '20'),
      GLOBAL_DAILY_TASK_LIMIT: bindings.text(process.env.BRAID_GLOBAL_DAILY_TASK_LIMIT || '100'),
      PUBLIC_ORIGIN: bindings.text(process.env.BRAID_PUBLIC_ORIGIN || ''),
      SIGNUP_ENABLED: bindings.text(process.env.BRAID_SIGNUP_ENABLED || 'false'),
      GITHUB_CLIENT_ID: bindings.text(process.env.BRAID_GITHUB_CLIENT_ID || ''),
      GITHUB_APP_ID: bindings.text(process.env.BRAID_GITHUB_APP_ID || ''),
      GITHUB_APP_SLUG: bindings.text(process.env.BRAID_GITHUB_APP_SLUG || ''),
      GITHUB_APP_CLIENT_ID: bindings.text(process.env.BRAID_GITHUB_APP_CLIENT_ID || ''),
      ...(process.env.BRAID_GITHUB_APP_ID ? { GITHUB_APP_CLIENT_SECRET: bindings.secret(), GITHUB_APP_PRIVATE_KEY: bindings.secret() } : {}),
      // Webhooks only speed GitHub sync up; the landing queue also polls, so they are enabled explicitly once the App sends them.
      ...(process.env.BRAID_GITHUB_APP_ID && process.env.BRAID_GITHUB_WEBHOOKS === '1' ? { GITHUB_APP_WEBHOOK_SECRET: bindings.secret() } : {}),
      ...(authMode === 'github' ? { GITHUB_CLIENT_SECRET: bindings.secret(), SESSION_SECRET: bindings.secret() } : {}),
      EMAIL_FROM: bindings.text(process.env.BRAID_EMAIL_FROM || ''),
      BUILD_ID: bindings.text(Date.now().toString(36)),
      ...(process.env.BRAID_EMAIL_FROM ? { EMAIL: bindings.sendEmail({ allowedSenderAddresses: [process.env.BRAID_EMAIL_FROM] }) } : {}),
    },
    exports: {
      Workspace: exports.durableObject({ storage: 'sqlite' }),
      AgentSandbox: exports.durableObject({ storage: 'sqlite', ...(containers ? { container: sandbox } : {}) }),
      GitHubRepo: exports.durableObject({ storage: 'sqlite' }),
      Security: exports.durableObject({ storage: 'sqlite' }),
      Directory: exports.durableObject({ storage: 'sqlite' }),
      ChangeShard: exports.durableObject({ storage: 'sqlite' }),
      Trunk: exports.durableObject({ storage: 'sqlite' }),
      PathIndex: exports.durableObject({ storage: 'sqlite' }),
      Swarm: exports.durableObject({ storage: 'sqlite' }),
      MissionWorkflow: exports.workflow({ name: workflowName }),
      VerifyWorkflow: exports.workflow({ name: verifyWorkflowName }),
    },
    limits: { cpuMs: 300_000 },
    observability: { enabled: true },
  },
};
});
