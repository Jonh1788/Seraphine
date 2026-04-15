import { useCallback, useEffect, useRef, useState } from 'react';
import { getAuthStatus, logoutGoogle, startOAuth } from './api';
import type { GoogleAuthStatus } from './types';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

/**
 * Sidebar panel for the Google Workspace OAuth state.
 *
 * Polls `/google/oauth/status` on mount. If not authed, shows a
 * "Conectar Google" button; clicking it opens the consent URL in a
 * new tab and starts polling for auth success. When the state
 * transitions to authed, dispatches a global `google-authed` event so
 * other panels can refresh.
 */
export function GoogleAuthPanel(): JSX.Element {
  const [status, setStatus] = useState<GoogleAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wasAuthedRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadlineRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setPolling(false);
  }, []);

  const applyStatus = useCallback((next: GoogleAuthStatus) => {
    setStatus(next);
    if (next.authed && !wasAuthedRef.current) {
      wasAuthedRef.current = true;
      window.dispatchEvent(new Event('google-authed'));
    }
    if (!next.authed) {
      wasAuthedRef.current = false;
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await getAuthStatus();
      applyStatus(s);
      return s;
    } catch (e) {
      setError(String(e));
      return null;
    }
  }, [applyStatus]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await refresh();
      setLoading(false);
    })();
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [refresh]);

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      const { consent_url } = await startOAuth();
      window.open(consent_url, '_blank', 'noopener,noreferrer');
      setPolling(true);
      pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = setInterval(async () => {
        const s = await refresh();
        if (s?.authed) {
          stopPolling();
        } else if (Date.now() > pollDeadlineRef.current) {
          stopPolling();
          setError('Tempo esgotado. Tente novamente.');
        }
      }, POLL_INTERVAL_MS);
    } catch (e) {
      setError(String(e));
    }
  }, [refresh, stopPolling]);

  const handleLogout = useCallback(async () => {
    try {
      await logoutGoogle();
      wasAuthedRef.current = false;
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }, [refresh]);

  const renderBody = () => {
    if (loading) {
      return <div className="google-auth__loading">Carregando...</div>;
    }
    if (!status || !status.authed) {
      return (
        <button
          type="button"
          className="google-auth__btn-connect"
          onClick={() => void handleConnect()}
          disabled={polling}
        >
          {polling ? 'Aguardando aprovacao...' : 'Conectar Google'}
        </button>
      );
    }
    const email = status.email ?? 'conta google';
    const initial = (email[0] || 'G').toUpperCase();
    return (
      <div className="google-auth__connected">
        <div className="google-auth__avatar" aria-hidden>{initial}</div>
        <span className="google-auth__email" title={email}>{email}</span>
        <button
          type="button"
          className="google-auth__btn-logout"
          onClick={() => void handleLogout()}
        >
          Desconectar
        </button>
      </div>
    );
  };

  return (
    <div className="google-auth">
      <h3 className="google-auth__title">Google Workspace</h3>
      {error && (
        <div className="google-auth__error">
          {error}
          <button type="button" onClick={() => setError(null)}>x</button>
        </div>
      )}
      {renderBody()}
    </div>
  );
}
