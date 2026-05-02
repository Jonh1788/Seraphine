/**
 * Top-level error boundary. Catches render-time exceptions in any
 * descendant and shows a minimal fallback so the entire shell doesn't
 * go blank. Reset is local to component state — refreshing or letting
 * the user retry can recover from transient failures (a stale ws
 * payload, an avatar load hiccup, etc.). Logs to console.error so the
 * stack still shows up in DevTools and Sentry-like collectors.
 */

import React, { type ReactNode } from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: undefined };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info);
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, error: undefined });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '20px', color: '#fff', background: '#08080d', minHeight: '100vh' }}>
          <h1>Algo quebrou.</h1>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {this.state.error?.message}
          </pre>
          <button
            type="button"
            onClick={this.handleReset}
            style={{
              marginTop: 16,
              padding: '8px 16px',
              background: '#1f1f29',
              color: '#fff',
              border: '1px solid #333',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            Tentar de novo
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
