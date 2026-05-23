import { useEffect, useState } from 'react';
import { listJobs } from './api';
import type { JobSummary } from './types';
import { JobDetailPanel } from './JobDetailPanel';

/**
 * Task 19 — JobsTab
 *
 * Top-level "Trabalhos" view. Shows a chronological list of every CV
 * triage job grouped by day. Clicking a row drills into
 * `<JobDetailPanel>`. The selected job id is session-local — not
 * persisted to the URL or storage — so reloading the tab returns the
 * user to the list.
 */

interface Props {
  /** When provided, the panel mounts directly on the detail view for
   *  this job. Used to deep-link from the in-chat progress card. */
  initialJobId?: number | null;
  /** Reset hook so the parent can clear `initialJobId` after we
   *  consume it once — re-mounting Trabalhos shouldn't auto-open the
   *  same job again. */
  onInitialJobConsumed?: () => void;
}

export function JobsTab({
  initialJobId,
  onInitialJobConsumed,
}: Props): JSX.Element {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(
    initialJobId ?? null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Consume the deep-link target exactly once.
  useEffect(() => {
    if (initialJobId != null) {
      setSelectedId(initialJobId);
      onInitialJobConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialJobId]);

  useEffect(() => {
    let cancelled = false;
    listJobs()
      .then((j) => {
        if (!cancelled) setJobs(j);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (selectedId !== null) {
    return (
      <JobDetailPanel jobId={selectedId} onClose={() => setSelectedId(null)} />
    );
  }

  if (loading) {
    return (
      <div className="cvt-jobs-tab">
        <header className="cvt-jobs-header">
          <h1>Trabalhos</h1>
        </header>
        <p className="cvt-empty">Carregando…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="cvt-jobs-tab">
        <header className="cvt-jobs-header">
          <h1>Trabalhos</h1>
        </header>
        <p className="cvt-detail-error">⚠ {error}</p>
      </div>
    );
  }

  const grouped = groupByDay(jobs);

  return (
    <div className="cvt-jobs-tab">
      <header className="cvt-jobs-header">
        <h1>Trabalhos</h1>
      </header>
      {grouped.length === 0 && (
        <p className="cvt-empty">Nenhum job ainda. Use a Triagem de CV no chat.</p>
      )}
      {grouped.map(({ label, items }) => (
        <section key={label} className="cvt-jobs-group">
          <h3>{label}</h3>
          <ul className="cvt-jobs-list">
            {items.map((j) => (
              <li
                key={j.id}
                className="cvt-jobs-row"
                onClick={() => setSelectedId(j.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedId(j.id);
                  }
                }}
              >
                <span className="cvt-jobs-meta">
                  <strong>
                    Triagem · {j.total_cvs} CV{j.total_cvs === 1 ? '' : 's'}
                  </strong>
                  <small>
                    {j.target_label} · {new Date(j.created_at).toLocaleString()}
                  </small>
                </span>
                <span className={`cvt-badge cvt-badge-${j.status}`}>
                  {j.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function groupByDay(
  jobs: JobSummary[],
): { label: string; items: JobSummary[] }[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today.getTime() - 86_400_000);
  const weekAgo = new Date(today.getTime() - 7 * 86_400_000);
  const buckets: Record<string, JobSummary[]> = {};
  for (const j of jobs) {
    const d = new Date(j.created_at);
    const label =
      d >= today
        ? 'Hoje'
        : d >= yesterday
          ? 'Ontem'
          : d >= weekAgo
            ? 'Esta semana'
            : 'Mais antigo';
    (buckets[label] ??= []).push(j);
  }
  return ['Hoje', 'Ontem', 'Esta semana', 'Mais antigo']
    .filter((l) => buckets[l]?.length)
    .map((label) => ({ label, items: buckets[label]! }));
}
