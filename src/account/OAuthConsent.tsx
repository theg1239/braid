import { useEffect, useState } from 'react';
import { Banner, Button, Radio, Select, SkeletonLine } from '@cloudflare/kumo';
import { CheckCircleIcon, ProhibitIcon } from '@phosphor-icons/react';
import { accountOwners, type Organization, type RepositoryWorkspace } from '../../shared/account';
import type { OAuthRequestView } from '../../shared/types';
import { errorMessage, request } from '../lib/api';
import { ACCOUNT_ACCESS } from '../../shared/types';
import { useAccount } from './AccountProvider';
import { GateLayout } from './GateLayout';

type Scope = OAuthRequestView['scope'];
type Answer = OAuthRequestView | { redirect: string };
type Stage = { kind: 'loading' } | { kind: 'ready'; view: OAuthRequestView } | { kind: 'refused'; message: string }
  | { kind: 'left'; title: string; done?: string };
type Repository = { team: Organization; workspace: RepositoryWorkspace };

const ACCESS: Record<Scope, { label: string; allows: string }> = {
  work: { label: 'Work', allows: 'Read code and open pull requests within your permissions.' },
  read: { label: 'Read', allows: 'Read code within your permissions.' },
};

/** Where the browser returns after the answer, in the words a person checks it by. */
export function returnsTo(redirect: OAuthRequestView['client']['redirect']): string {
  return redirect.kind === 'loopback' ? `This computer (${redirect.host})` : redirect.kind === 'app' ? `The ${redirect.host} app` : redirect.host;
}

/**
 * An MCP client asks for access through OAuth. The person sees the client's name, where the answer goes and what it
 * could do, chooses account access or a repository, and grants it by pressing Authorize.
 */
export function OAuthConsent({ query }: { query: URLSearchParams }) {
  const { account } = useAccount();
  const search = query.toString();
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const repositories = accountOwners(account).flatMap(team => team.workspaces.map(workspace => ({ team, workspace })));

  useEffect(() => {
    let cancelled = false;
    request<Answer>(`/api/oauth/authorize?${search}`)
      .then(answer => {
        if (cancelled) return;
        // A request with a problem goes back to the client, which reads the error.
        if ('redirect' in answer) { setStage({ kind: 'left', title: 'Returning to the client' }); window.location.assign(answer.redirect); }
        else setStage({ kind: 'ready', view: answer });
      })
      .catch((err: unknown) => { if (!cancelled) setStage({ kind: 'refused', message: errorMessage(err) }); });
    return () => { cancelled = true; };
  }, [search]);

  if (stage.kind === 'refused') {
    return (
      <GateLayout title="Authorize a client">
        <Banner variant="error" size="sm" description={stage.message} />
      </GateLayout>
    );
  }
  if (stage.kind === 'left') {
    return (
      <GateLayout title={stage.title}>
        {stage.done ? <p className="connect__done"><CheckCircleIcon size={18} weight="fill" aria-hidden="true" />{stage.done}</p> : null}
      </GateLayout>
    );
  }
  const answer = async (decision: 'approve' | 'deny', workspaceId: string, scope: Scope) => {
    const { redirect } = await request<{ redirect: string }>('/api/oauth/authorize', { method: 'POST', body: JSON.stringify({ request: Object.fromEntries(query), decision, ...(decision === 'approve' ? { workspaceId, scope } : {}) }) });
    const view = stage.kind === 'ready' ? stage.view : null;
    const chosen = repositories.find(repository => repository.workspace.id === workspaceId);
    setStage(decision === 'approve' && view
      ? { kind: 'left', title: 'Authorized', done: `${view.client.name} can now use ${chosen ? `${chosen.team.slug}/${chosen.workspace.slug}` : 'your account'}.` }
      : { kind: 'left', title: 'Request denied' });
    window.location.assign(redirect);
  };
  return <ConsentForm view={stage.kind === 'ready' ? stage.view : null} repositories={repositories} onAnswer={answer} />;
}

/** The request, the person's choices and the two answers; `view` is null while the request loads. */
export function ConsentForm({ view, repositories, onAnswer }: {
  view: OAuthRequestView | null;
  repositories: Repository[];
  onAnswer: (decision: 'approve' | 'deny', workspaceId: string, scope: Scope) => Promise<void>;
}) {
  const [picked, setPicked] = useState<string>(ACCOUNT_ACCESS);
  const [scope, setScope] = useState<Scope | null>(null);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const granted = scope ?? view?.scope ?? 'work';
  const choices = repositories.filter(({ team, workspace }) => granted === 'read' || team.role === 'owner' || workspace.canWrite);
  const workspaceId = choices.some(({ workspace }) => workspace.id === picked) ? picked : ACCOUNT_ACCESS;
  const decide = async (decision: 'approve' | 'deny') => {
    if (!view || busy) return;
    setBusy(decision);
    setError(null);
    try { await onAnswer(decision, workspaceId, granted); }
    catch (err) { setError(errorMessage(err)); setBusy(null); }
  };
  return (
    <GateLayout title={view ? `Authorize ${view.client.name}` : 'Authorize a client'}>
      <dl className="connect">
        <dt>Returns to</dt>
        <dd>{view ? returnsTo(view.client.redirect) : <SkeletonLine className="connect__skeleton" />}</dd>
        {view?.client.document ? <><dt>Published by</dt><dd>{view.client.document}</dd></> : null}
        <dt>Repositories</dt>
        <dd>
          <Select aria-label="Repositories" value={workspaceId} onValueChange={value => value && setPicked(String(value))}
            items={[{ value: ACCOUNT_ACCESS, label: 'All repositories you can access' }, ...choices.map(({ team, workspace }) => ({ value: workspace.id, label: `${team.slug}/${workspace.slug}` }))]} />
        </dd>
      </dl>

      {view?.scope === 'work' ? (
        <Radio.Group legend="Access" orientation="horizontal" value={granted} onValueChange={value => setScope(value as Scope)}>
          <Radio.Item value="work" label={ACCESS.work.label} />
          <Radio.Item value="read" label={ACCESS.read.label} />
        </Radio.Group>
      ) : null}

      {view ? (
        <ul className="connect__scope">
          <li>{ACCESS[granted].allows}</li>
          <li className="connect__cannot">
            <ProhibitIcon size={14} aria-hidden="true" />
            It cannot approve or merge pull requests, or change who has access.
          </li>
        </ul>
      ) : null}

      {view?.client.redirect.kind === 'loopback' ? <Banner variant="alert" size="sm" description="Approve only if you started this sign-in on this computer." /> : null}
      {error ? <Banner variant="error" size="sm" description={error} /> : null}

      <div className="gate__actions">
        <Button variant="secondary" loading={busy === 'deny'} disabled={!view || (!!busy && busy !== 'deny')} onClick={() => void decide('deny')}>
          Deny
        </Button>
        <Button variant="primary" loading={busy === 'approve'} disabled={!view || (!!busy && busy !== 'approve')} onClick={() => void decide('approve')}>
          Authorize
        </Button>
      </div>
    </GateLayout>
  );
}
