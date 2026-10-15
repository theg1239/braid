import type { ReactNode } from 'react';
import { GlobalHeader } from '../components/shell/GlobalHeader';
import { useDocumentTitle } from '../lib/title';
import '../styles/account.css';

/** The quiet frame around sign-in, team setup and approvals: the mark, one column, and a footer for secondary actions. */
export function GateLayout({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  useDocumentTitle(`${title} · Braid`);
  return (
    <div className="gate">
      <a href="#main" className="skip-link">Skip to content</a>
      <GlobalHeader />
      <main id="main" className="gate__main" tabIndex={-1}>
        <section className="gate__card" aria-labelledby="gate-title">
          <h1 className="gate__title" id="gate-title">
            {title}
          </h1>
          {children}
        </section>
        {footer ? <footer className="gate__footer">{footer}</footer> : null}
      </main>
    </div>
  );
}
