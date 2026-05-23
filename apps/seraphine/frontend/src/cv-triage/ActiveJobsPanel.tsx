import { useEffect, useState } from 'react';
import { listJobs } from './api';
import type { JobSummary } from './types';
import { JobProgressCard, type WsSubscribe } from './JobProgressCard';

/**
 * Task 18 — ActiveJobsPanel
 *
 * Wrapper that renders one <JobProgressCard> for every job that is
 * either currently running or recently finished (within RECENT_DONE_MS).
 * Mounted between the message list and the chat composer.
 *
 * Note on the spec adaptation: the original design asked to filter by
 * `conversation_id == active conversation id`. The current `JobSummary`
 * schema has no `conversation_id` field, so we render globally — the
 * Trabalhos tab (Task 19) provides the canonical browse view. If
 * per-conversation filtering becomes important we'll need a schema
 * extension first.
 */

const RECENT_DONE_MS = 30 * 60 * 1000; // 30 min
const REFRESH_MS = 30_000; // re-query /cv_triage/jobs every 30s
const ACTIVE_STATUSES = new Set(['queued', 'extracting', 'ranking', 'sending']);

interface Props {
  onNavigate: (jobId: number) => void;
  subscribeWS?: WsSubscribe;
}

export function ActiveJobsPanel({ onNavigate, subscribeWS }: Props): JSX.Element | null {
  const [jobs, setJobs] = useState<JobSummary[]>([]);

  useEffect(() => {
    let cancelled = false;

    function load(): void {
      listJobs()
        .then((all) => {
          if (cancelled) return;
          const now = Date.now();
          const visible = all.filter((j) => {
            if (ACTIVE_STATUSES.has(j.status)) return true;
            if (!j.finished_at) return false;
            const age = now - new Date(j.finished_at).getTime();
            return age < RECENT_DONE_MS;
          });
          setJobs(visible);
        })
        .catch(() => {
          /* keep last-known list */
        });
    }

    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (jobs.length === 0) return null;

  return (
    <div className="cvt-active-panel" data-testid="cvt-active-panel">
      {jobs.map((j) => (
        <JobProgressCard
          key={j.id}
          jobId={j.id}
          onNavigate={onNavigate}
          subscribeWS={subscribeWS}
        />
      ))}
    </div>
  );
}
