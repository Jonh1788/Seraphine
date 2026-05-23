import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getJob, cancelJob } from './api';
import type { JobDetail, JobStatus } from './types';

/**
 * Task 19 — JobDetailPanel
 *
 * Full detail view for a single CV-triage job. Polls `getJob(id)` while
 * the job is in an active phase (queued/extracting/ranking/sending),
 * then stops to avoid background traffic. Lets the user cancel an
 * in-flight job and open the original PDF via the Tauri
 * `open_path_local` command — but only if the source folder for the
 * job was cached in this session by the wizard (Task 17).
 */

interface Props {
  jobId: number;
  onClose: () => void;
}

const POLL_MS = 2500;
const ACTIVE: JobStatus[] = ['queued', 'extracting', 'ranking', 'sending'];

export function JobDetailPanel({ jobId, onClose }: Props): JSX.Element {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const j = await getJob(jobId);
        if (!cancelled) {
          setJob(j);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    }

    void load();
    const t = setInterval(() => {
      if (job && !ACTIVE.includes(job.status)) return;
      void load();
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [jobId, job?.status]);

  if (error) {
    return (
      <div className="cvt-detail cvt-detail-error-wrap">
        <header className="cvt-detail-header">
          <button className="cvt-back" onClick={onClose} aria-label="Voltar">
            ← Voltar
          </button>
        </header>
        <p className="cvt-detail-error">⚠ {error}</p>
      </div>
    );
  }
  if (!job) {
    return (
      <div className="cvt-detail">
        <header className="cvt-detail-header">
          <button className="cvt-back" onClick={onClose} aria-label="Voltar">
            ← Voltar
          </button>
        </header>
        <p>Carregando…</p>
      </div>
    );
  }

  const folder = sessionStorage.getItem(`cv_triage:job_${jobId}_folder`);
  const sorted = [...(job.results ?? [])].sort(
    (a, b) => (b.score ?? -1) - (a.score ?? -1),
  );

  async function openPdf(filename: string): Promise<void> {
    if (!folder) {
      alert(
        'Pasta original não cacheada nesta sessão — abra o wizard novamente para reabrir os PDFs.',
      );
      return;
    }
    try {
      // Tauri command signature: `open_path_local(target: String)`
      await invoke('open_path_local', { target: `${folder}/${filename}` });
    } catch (e) {
      alert(`Falha ao abrir: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleCancel(): Promise<void> {
    try {
      await cancelJob(jobId);
    } catch {
      /* fire-and-forget — polling will reflect the new state */
    }
  }

  return (
    <div className="cvt-detail">
      <header className="cvt-detail-header">
        <button className="cvt-back" onClick={onClose} aria-label="Voltar">
          ← Voltar
        </button>
        <h2 className="cvt-detail-title">
          Job #{job.id}{' '}
          <span className={`cvt-badge cvt-badge-${job.status}`}>{job.status}</span>
        </h2>
        {ACTIVE.includes(job.status) && (
          <button
            type="button"
            className="cvt-cancel-btn"
            onClick={() => void handleCancel()}
          >
            Cancelar
          </button>
        )}
      </header>

      <section className="cvt-meta-block">
        <p>
          <strong>Vaga:</strong> {job.rubric}
        </p>
        <p>
          <strong>Destino:</strong> {job.target_label}
        </p>
        <p>
          <strong>Progresso:</strong> {job.processed_cvs}/{job.total_cvs} · OCR:{' '}
          {job.ocr_used_count} · Vision: {job.vision_used_count} · Ilegíveis:{' '}
          {job.unreadable}
        </p>
        <p>
          <strong>Criado:</strong> {new Date(job.created_at).toLocaleString()}
        </p>
        {job.finished_at && (
          <p>
            <strong>Finalizado:</strong>{' '}
            {new Date(job.finished_at).toLocaleString()}
          </p>
        )}
        {job.whatsapp_status && (
          <p>
            <strong>WhatsApp:</strong> {job.whatsapp_status}
          </p>
        )}
        {job.error && (
          <p className="cvt-detail-error">
            <strong>Erro:</strong> {job.error}
          </p>
        )}
        {!folder && (
          <p className="cvt-detail-hint">
            Pasta original não cacheada nesta sessão — botões "Abrir" do PDF
            ficam indisponíveis até reabrir o wizard.
          </p>
        )}
      </section>

      {sorted.length === 0 ? (
        <p className="cvt-empty">Nenhum resultado ainda.</p>
      ) : (
        <table className="cvt-results-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Candidato</th>
              <th>Arquivo</th>
              <th>Score</th>
              <th>Match</th>
              <th>Fonte</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={r.filename} className={`cvt-row cvt-row-${r.status}`}>
                <td>{i + 1}</td>
                <td>{r.candidate_name ?? '—'}</td>
                <td className="cvt-fname">{r.filename}</td>
                <td>{r.score != null ? r.score.toFixed(0) : '—'}</td>
                <td>{r.match_pct != null ? r.match_pct.toFixed(0) : '—'}</td>
                <td>{r.text_source}</td>
                <td>
                  {r.status}
                  {r.error ? ` (${r.error})` : ''}
                </td>
                <td>
                  <button
                    type="button"
                    className="cvt-open-pdf"
                    onClick={() => void openPdf(r.filename)}
                    disabled={!folder}
                    title={folder ? 'Abrir PDF' : 'Pasta não cacheada nesta sessão'}
                  >
                    Abrir
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
