import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ErrorBoundary } from './ErrorBoundary';

vi.mock('@cloudflare/kumo', () => ({
  Empty: (props: { title: string; contents?: React.ReactNode }) => <section><h2>{props.title}</h2>{props.contents}</section>,
  Button: (props: { children: string; onClick(): void }) => <button onClick={props.onClick}>{props.children}</button>,
}));

describe('the error boundary', () => {
  it('shows a panel with Reload in place of what crashed, until the page changes', () => {
    const crashed = ErrorBoundary.getDerivedStateFromError(new Error('useRepository must be used inside RepositoryGate.'));
    const boundary = new ErrorBoundary({ children: <p>Code</p>, resetKey: '/example/relay' });
    expect(renderToStaticMarkup(<>{boundary.render()}</>)).toBe('<p>Code</p>');
    boundary.state = { ...boundary.state, ...crashed };
    const panel = renderToStaticMarkup(<>{boundary.render()}</>);
    expect(panel).toContain('<h1>Unable to load this page</h1>');
    expect(panel).toContain('<button>Reload</button>');
    expect(panel).not.toContain('RepositoryGate');
    // The same page keeps the panel; the next one renders its children again.
    expect(ErrorBoundary.getDerivedStateFromProps({ resetKey: '/example/relay' }, boundary.state)).toBeNull();
    expect(ErrorBoundary.getDerivedStateFromProps({ resetKey: '/example/relay/pulls' }, boundary.state)).toEqual({ error: null, resetKey: '/example/relay/pulls' });
  });
});
