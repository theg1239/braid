import { useEffect, useState } from 'react';
import { Banner, Button, Radio, Select, SkeletonLine, useKumoToastManager } from '@cloudflare/kumo';
import { CheckCircleIcon, ProhibitIcon } from '@phosphor-icons/react';
import { accountOwners } from '../../shared/account';
import { ACCOUNT_ACCESS } from '../../shared/types';
import { ApiError, errorMessage } from '../lib/api';
import { plural } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useAccount } from './AccountProvider';
import { AGENT_SCOPE, accountApi, type AgentRequest, type AgentScope } from './api';
import { GateLayout } from './GateLayout';
import { formatConnectCode } from './session';

type Stage = { kind: 'loading' } | { kind: 'ready'; request: AgentRequest } | { kind: 'gone'; message: string } | { kind: 'approved'; label: string };

function remaining(expires: number, now: number): string {
  const minutes = Math.ceil((expires - now) / 60_000);
  return minutes <= 0 ? 'Expired' : `Expires in ${plural(minutes, 'minute')}`;
}

const GONE = 'This request expired or was already handled. Start the connection again from your agent.';

/**
 * An agent asked for access with a code this person opened. It shows who is asking and
 * what they could do, and nothing is granted until the person presses Approve.
 */
export function ConnectApproval() {
  const { account, pendingConnect, settleConnect } = useAccount();
  const toasts = useKumoToastManager();
  const now = useNow(5_000);
  const code = pendingConnect ?? '';
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grant, setGrant] = useState<AgentScope>('read');
  const owned = accountOwners(account).flatMap((team) => team.workspaces.filter(workspace => grant === 'read' || team.role === 'owner' || workspace.canWrite).map((workspace) => ({ team, workspace })));
  const [picked, setPicked] = useState<string>(ACCOUNT_ACCESS);
  const workspaceId = owned.some((o) => o.workspace.id === picked) ? picked : ACCOUNT_ACCESS;

  useEffect(() => {
    let cancelled = false;
    accountApi
      .agentRequest(code)
      .then((request) => {
        if (cancelled) return;
        setStage({ kind: 'ready', request });
        setGrant(request.scope);
      })
      .catch((err: unknown) => {
        if (!cancelled) setStage({ kind: 'gone', message: err instanceof ApiError && err.status === 410 ? GONE : errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  const decide = async (approve: boolean) => {
    if (stage.kind !== 'ready' || busy) return;
    setBusy(approve ? 'approve' : 'deny');
    setError(null);
    try {
      if (approve) {
        await accountApi.approveAgent(code, workspaceId, grant);
        setStage({ kind: 'approved', label: stage.request.label });
      } else {
        await accountApi.denyAgent(code);
        toasts.add({ title: 'Agent request denied', description: stage.request.label });
        settleConnect();
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) setStage({ kind: 'gone', message: GONE });
      else setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (stage.kind === 'approved') {
    return (
      <GateLayout title="Agent connected">
        <p className="connect__done">
          <CheckCircleIcon size={18} weight="fill" aria-hidden="true" />
          {stage.label} can now use {workspaceId === ACCOUNT_ACCESS ? 'your account' : 'the repository you selected'}.
        </p>
        <Button variant="primary" className="gate__wide" onClick={settleConnect}>
          Open Braid
        </Button>
      </GateLayout>
    );
  }

  if (stage.kind === 'gone') {
    return (
      <GateLayout title="Connect an agent">
        <Banner variant="alert" size="sm" description={stage.message} />
        <Button variant="primary" className="gate__wide" onClick={settleConnect}>
          Continue
        </Button>
      </GateLayout>
    );
  }

  const request = stage.kind === 'ready' ? stage.request : null;
  const expired = !!request && request.expires <= now;
  return (
    <GateLayout title="Connect an agent">
      <dl className="connect">
        <dt>Code</dt>
        <dd className="mono connect__code">{formatConnectCode(code)}</dd>
        <dt>Agent</dt>
        <dd>{request ? request.label : <SkeletonLine className="connect__skeleton" />}</dd>
        <dt>Repositories</dt>
        <dd>
          <Select
            aria-label="Repositories"
            value={workspaceId}
            onValueChange={(value) => value && setPicked(String(value))}
            items={[{ value: ACCOUNT_ACCESS, label: 'All repositories you can access' }, ...owned.map(({ team, workspace }) => ({ value: workspace.id, label: `${team.name} / ${workspace.name}` }))]}
          />
        </dd>
      </dl>

      {request && request.scope !== 'read' ? (
        <Radio.Group legend="Access" orientation="horizontal" value={grant} onValueChange={(value) => setGrant(value as AgentScope)}>
          <Radio.Item value={request.scope} label={AGENT_SCOPE[request.scope].label} />
          <Radio.Item value="read" label={AGENT_SCOPE.read.label} />
        </Radio.Group>
      ) : null}

      {request ? (
        <ul className="connect__scope">
          <li>{AGENT_SCOPE[grant].allows}</li>
          <li className="connect__cannot">
            <ProhibitIcon size={14} aria-hidden="true" />
            It cannot choose versions, merge into main, or manage your organization.
          </li>
        </ul>
      ) : null}

      {request ? <p className="connect__expiry">{remaining(request.expires, now)}</p> : null}
      {error ? <Banner variant="error" size="sm" description={error} /> : null}

      <div className="gate__actions">
        <Button variant="secondary" loading={busy === 'deny'} disabled={!request || (!!busy && busy !== 'deny')} onClick={() => void decide(false)}>
          Deny
        </Button>
        <Button variant="primary" loading={busy === 'approve'} disabled={!request || expired || (!!busy && busy !== 'approve')} onClick={() => void decide(true)}>
          Approve
        </Button>
      </div>
    </GateLayout>
  );
}
