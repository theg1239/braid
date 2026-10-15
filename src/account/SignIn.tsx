import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Banner, Button, Input, LinkButton } from '@cloudflare/kumo';
import { EnvelopeSimpleIcon, FingerprintIcon, GithubLogoIcon } from '@phosphor-icons/react';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { errorMessage, resetWorkspaceCaches } from '../lib/api';
import { EXAMPLE_ADDRESS, isAppPath, navigate, paths } from '../lib/router';
import { useDocumentTitle } from '../lib/title';
import { Mark } from '../components/shell/Mark';
import { GlobalHeader } from '../components/shell/GlobalHeader';
import { RouterLink } from '../components/ui/Link';
import { useAccount } from './AccountProvider';
import { AccountRetry } from './AccountRetry';
import { resetAddresses } from './addresses';
import { accountApi, passkeyError } from './api';
import { formatConnectCode, writeSession } from './session';
import '../styles/account.css';

type Busy = 'email' | 'code' | 'passkey' | null;

/** Sign-in, as the page at /signin that returns to `next`, or as the gate an invitation or agent request waits behind. */
export function SignIn({ next = null, confirm = false }: { next?: string | null; confirm?: boolean }) {
  const { account, refresh, error: accountError, pendingInvite, pendingConnect } = useAccount();
  const returnTo = next && isAppPath(next) ? next : confirm ? paths.accountSettings() : null;
  // The gate shows sign-in only once the account answered.
  const methods = account!.methods;
  const passkeys = methods.passkeys && browserSupportsWebAuthn();
  const [email, setEmail] = useState('');
  const [flow, setFlow] = useState<{ id: string; email: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(kind === 'passkey' ? passkeyError(err) : errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const sendCode = (address: string) => {
    if (!address || busy) return;
    void run('email', async () => {
      const started = await accountApi.emailStart(address);
      setFlow({ id: started.flowId, email: address });
      setCode('');
      window.setTimeout(() => codeInput.current?.focus(), 0);
    });
  };

  const verify = (event: FormEvent) => {
    event.preventDefault();
    if (!flow || busy) return;
    void run('code', async () => {
      await accountApi.emailVerify(flow.id, code);
      signedIn();
    });
  };

  const usePasskey = () =>
    void run('passkey', async () => {
      const { flowId, options } = await accountApi.passkeySignInOptions();
      const response = await startAuthentication({ optionsJSON: options });
      await accountApi.passkeySignIn(flowId, response);
      signedIn();
    });

  /** Cached reads belong to the previous session; return to the page that asked for sign-in. */
  const signedIn = () => {
    resetWorkspaceCaches();
    resetAddresses();
    if (returnTo) navigate(returnTo, { replace: true });
    void refresh();
  };
  // GitHub brings the browser back to the site's home; the page the person was on is kept in this tab.
  const github = () => writeSession('next', returnTo);

  if (accountError) return <SignInPage><p className="quiet">Sign-in is temporarily unavailable.</p><AccountRetry /></SignInPage>;

  if (account?.provider === 'access') {
    return (
      <SignInPage>
        <Button variant="primary" className="gate__wide" onClick={() => window.location.reload()}>
          Continue with Cloudflare Access
        </Button>
      </SignInPage>
    );
  }

  return (
    <SignInPage confirm={confirm}>
      {pendingConnect ? <Banner variant="secondary" size="sm" description={`Sign in to review agent request ${formatConnectCode(pendingConnect)}.`} /> : null}
      {pendingInvite ? <Banner variant="secondary" size="sm" description="Sign in with the email address your invitation was sent to." /> : null}
      {error ? <Banner variant="error" size="sm" description={error} /> : null}

      {methods.github ? (
        <LinkButton href="/api/auth/github" variant="primary" icon={GithubLogoIcon} className="gate__wide" onClick={github}>
          Continue with GitHub
        </LinkButton>
      ) : null}

      {methods.email ? (
        <>
          {methods.github ? (
            <p className="gate__or" aria-hidden="true">
              or
            </p>
          ) : null}
          {flow ? (
            <form className="gate__form" onSubmit={verify}>
              <Input
                ref={codeInput}
                label="Sign-in code"
                description="Check your email for the code."
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                autoComplete="one-time-code"
                spellCheck={false}
                maxLength={9}
                className="gate__code"
                passwordManagerIgnore
              />
              <Button type="submit" variant={methods.github ? 'secondary' : 'primary'} className="gate__wide" loading={busy === 'code'} disabled={code.replace(/[\s-]/g, '').length !== 8}>
                Sign in
              </Button>
              <span className="gate__row">
                <Button variant="ghost" size="sm" onClick={() => setFlow(null)} disabled={!!busy}>
                  Use a different email
                </Button>
                <Button variant="ghost" size="sm" loading={busy === 'email'} onClick={() => sendCode(flow.email)} disabled={!!busy}>
                  Send a new code
                </Button>
              </span>
            </form>
          ) : (
            <form
              className="gate__form"
              onSubmit={(event) => {
                event.preventDefault();
                sendCode(email.trim());
              }}
            >
              <Input label="Email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" maxLength={254} />
              <Button type="submit" variant={methods.github ? 'secondary' : 'primary'} icon={EnvelopeSimpleIcon} className="gate__wide" loading={busy === 'email'} disabled={!email.trim()}>
                Email me a code
              </Button>
            </form>
          )}
        </>
      ) : null}

      {passkeys ? (
        <Button variant="secondary" icon={FingerprintIcon} className="gate__wide" loading={busy === 'passkey'} disabled={!!busy && busy !== 'passkey'} onClick={usePasskey}>
          Sign in with a passkey
        </Button>
      ) : null}

      {!methods.github && !methods.email && !passkeys ? <Banner variant="alert" size="sm" description="Sign-in is not configured for this deployment yet." /> : null}
    </SignInPage>
  );
}

/** The sign-in page: the mark over one column of ways in, and the example quietly below. */
function SignInPage({ children, confirm = false }: { children: ReactNode; confirm?: boolean }) {
  const title = confirm ? 'Confirm it’s you' : 'Sign in to Braid';
  useDocumentTitle(confirm ? 'Confirm it’s you · Braid' : 'Sign in · Braid');
  return (
    <div className="signin">
      <a href="#main" className="skip-link">Skip to content</a>
      <GlobalHeader />
      <main id="main" className="signin__main" tabIndex={-1}>
        <section className="signin__box" aria-labelledby="signin-title">
          <Mark size={32} />
          <h1 className="signin__title" id="signin-title">
            {title}
          </h1>
          {children}
        </section>
        <footer className="signin__foot">
          <RouterLink href={paths.repo(EXAMPLE_ADDRESS)} className="signin__example">
            Explore the example
          </RouterLink>
        </footer>
      </main>
    </div>
  );
}
