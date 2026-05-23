import { useEffect, useState } from 'react';
import { getJob } from './api';
import type { JobDetail } from './types';

/**
 * Task 18 — JobProgressCard
 *
 * Live progress card for a single CV-triage job. Mounted above the chat
 * composer (see ActiveJobsPanel). Subscribes to the existing Seraphine WS
 * stream for `cv_triage_progress` / `cv_triage_finished` frames matching
 * its `job_id`. Falls back to polling `getJob(id)` every 2s if no
 * `subscribeWS` adapter is provided.
 *
 * The original design called for embedding this as a chat turn, but the
 * `turns` table only supports plain user/assistant rows — no arbitrary
 * payload. We render as a chat-surface affordance instead.
 */

/** Listener signature compatible with `SeraphineWS.onMessage` after the
 *  binary-frame filter is applied. The adapter passed from ChatView
 *  forwards JSON frames (raw objects) to this listener. */
export type WsFrameListener = (msg: unknown) => void;
export type WsSubscribe = (handler: WsFrameListener) => () => void;

interface Props {
  jobId: number;
  onNavigate: (jobId: number) => void;
  /** Optional WS subscription hook. Receives unsubscribe on cleanup. */
  subscribeWS?: WsSubscribe;
}

const POLL_INTERVAL_MS = 2000;
const ACTIVE_STATUSES = new Set(['queued', 'extracting', 'ranking', 'sending']);

interface ProgressFrameLike {
  type: 'cv_triage_progress';
  job_id: number;
  phase: 'extracting' | 'ranking' | 'sending';
  processed: number;
  total: number;
  current_filename?: string;
  ocr_used_count?: number;
  vision_used_count?: number;
}

interface FinishedFrameLike {
  type: 'cv_triage_finished';
  job_id: number;
}

function isProgressFrame(msg: unknown): msg is ProgressFrameLike {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'cv_triage_progress'
  );
}
function isFinishedFrame(msg: unknown): msg is FinishedFrameLike {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'cv_triage_finished'
  );
}

export function JobProgressCard({ jobId, onNavigate, subscribeWS }: Props): JSX.Element | null {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Initial fetch
  useEffect(() => {
    let cancelled = false;
    getJob(jobId)
      .then((j) => {
        if (!cancelled) setJob(j);
      })
      .catch(() => {
        /* leave job null — card hides */
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Live updates: WS subscription preferred, polling fallback otherwise.
  useEffect(() => {
    if (!job) return;
    const isActive = ACTIVE_STATUSES.has(job.status);
    if (!isActive) return;

    if (subscribeWS) {
      const unsubscribe = subscribeWS((msg) => {
        if (isProgressFrame(msg)) {
          if (msg.job_id !== jobId) return;
          setJob((prev) =>
            prev
              ? {
                  ...prev,
                  processed_cvs: msg.processed,
                  total_cvs: msg.total,
                  ocr_used_count: msg.ocr_used_count ?? prev.ocr_used_count,
                  vision_used_count: msg.vision_used_count ?? prev.vision_used_count,
                  status: msg.phase,
                }
              : prev,
          );
        } else if (isFinishedFrame(msg)) {
          if (msg.job_id !== jobId) return;
          // Re-fetch the full job to pick up top5 / final status / error.
          getJob(jobId)
            .then((j) => setJob(j))
            .catch(() => {});
        }
      });
      return unsubscribe;
    }

    // No WS adapter — fall back to polling.
    const t = setInterval(() => {
      getJob(jobId)
        .then((j) => setJob(j))
        .catch(() => {});
    }, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [job, jobId, subscribeWS]);

  if (!job) return null;

  const isActive = ACTIVE_STATUSES.has(job.status);
  const pct = job.total_cvs ? Math.round((100 * job.processed_cvs) / job.total_cvs) : 0;

  if (collapsed) {
    return (
      <div
        className="cvt-progress-card cvt-progress-card--collapsed"
        onClick={() => setCollapsed(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCollapsed(false);
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Expandir cartão de triagem"
      >
        <span>
          Triagem · {job.processed_cvs}/{job.total_cvs} · {phaseLabel(job)}
        </span>
      </div>
    );
  }

  return (
    <div className="cvt-progress-card">
      <header className="cvt-pc-header">
        <button
          type="button"
          className="cvt-pc-title"
          onClick={() => setCollapsed(true)}
          aria-label="Colapsar"
        >
          <strong>
            Triagem de CV — {job.total_cvs} currículo{job.total_cvs === 1 ? '' : 's'}
          </strong>
        </button>
        <button
          type="button"
          className="cvt-pc-open"
          onClick={() => onNavigate(jobId)}
          aria-label="Abrir detalhe"
          title="Abrir detalhe"
        >
          {'→'}
        </button>
      </header>

      {isActive && (
        <>
          <div className="cvt-pc-bar">
            <div className="cvt-pc-fill" style={{ width: `${pct}%` }} />
          </div>
          <p className="cvt-pc-status">{phaseLabel(job)}</p>
        </>
      )}

      {job.status === 'done' && job.top5 && job.top5.length > 0 && (
        <ol className="cvt-pc-top5">
          {job.top5.slice(0, 5).map((t) => (
            <li key={t.rank}>
              <strong>
                {t.rank}. {t.candidate_name ?? t.filename}
              </strong>
              <span className="cvt-pc-score"> · score {t.score.toFixed(0)}</span>
            </li>
          ))}
        </ol>
      )}

      {job.status === 'failed' && <p className="cvt-pc-error">{job.error ?? 'Falha'}</p>}
      {job.status === 'cancelled' && <p className="cvt-pc-cancelled">Cancelado</p>}

      <p className="cvt-pc-target">
        {'→'} {job.target_label}
      </p>
    </div>
  );
}

function phaseLabel(job: JobDetail): string {
  const ocr = job.ocr_used_count;
  const vision = job.vision_used_count;
  switch (job.status) {
    case 'queued':
      return 'Preparando arquivos…';
    case 'extracting':
      return `Lendo CVs${ocr ? ` · OCR em ${ocr}` : ''}${vision ? ` · Vision em ${vision}` : ''}`;
    case 'ranking':
      return 'Avaliando contra a vaga';
    case 'sending':
      return 'Enviando pelo WhatsApp…';
    default:
      return '';
  }
}
