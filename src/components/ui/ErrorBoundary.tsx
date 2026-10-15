import { Component, type ReactNode } from 'react';
import { ErrorPanel } from './States';

/**
 * A crash while rendering what is inside shows a panel with Reload in its place, so the rest of the page
 * stays: the header around a screen, or a page instead of a blank window. A new `resetKey`, such as the
 * address of the next page, renders the children again.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string; root?: boolean }, { error: unknown; resetKey?: string }> {
  state: { error: unknown; resetKey?: string } = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { resetKey?: string }) {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  render() {
    if (!this.state.error) return this.props.children;
    const Tag = this.props.root ? 'main' : 'div';
    return (
      <Tag className="page" id={this.props.root ? 'main' : undefined}>
        <ErrorPanel page title="Unable to load this page" onRetry={() => window.location.reload()} retryLabel="Reload" />
      </Tag>
    );
  }
}
