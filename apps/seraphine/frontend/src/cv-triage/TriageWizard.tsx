// CV Triage — Task 17.
//
// 3-step wizard that bundles a folder of PDFs, attaches a job rubric and a
// WhatsApp destination, then POSTs the zip to the Seraphine backend's
// `/cv_triage/jobs` endpoint (see `./api.ts`).
//
// Step 1: pick a folder via `@tauri-apps/plugin-dialog` and preview the PDF
//         count using the existing `list_dir_local` Tauri command (Mac
//         tool proxy — see `src-tauri/src/mac_tools.rs`).
// Step 2: free-form job rubric (minimum 30 chars to keep ranking useful).
// Step 3: pick the WhatsApp destination from `/whatsapp/chats` (groups
//         first, then 1:1 contacts; cached for 5 min in api.ts).
//
// On submit:
//   1. Tauri zips the folder in-memory via `zip_folder_pdfs` (Task 15).
//   2. `createJob()` uploads the zip + rubric + target as multipart.
//   3. The originating folder path is cached in sessionStorage so the
//      "Trabalhos" tab (Task 19) can offer an "Abrir PDF" action for each
//      Top-5 result without re-querying the user.
//   4. The backend broadcasts a new turn over the WS — the modal closes
//      and the new JobProgressCard (Task 18) takes over in the chat.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { open as openFolderDialog } from '@tauri-apps/plugin-dialog';
import { XIcon } from '../icons/Icons';
import { listChats, createJob } from './api';
import type { Chat } from './types';

interface Props {
  onClose: () => void;
  onCreated: (jobId: number) => void;
}

/** Minimum useful rubric length — short enough to not block real cases,
 * long enough to keep the LLM from ranking against a one-liner. */
const MIN_RUBRIC = 30;

/** Mirrors the filter in `src-tauri/src/cv_triage_zip.rs::walk_pdfs` so
 * the count shown in the wizard matches the actual zip contents. */
const PDF_RE = /\.pdf$/i;
function isCountedPdf(name: string): boolean {
  if (name.startsWith('._')) return false; // AppleDouble
  if (name === '.DS_Store') return false;
  // `list_dir_local` appends "/" to directory entries — exclude them.
  if (name.endsWith('/')) return false;
  return PDF_RE.test(name);
}

export function TriageWizard({ onClose, onCreated }: Props): JSX.Element {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [folder, setFolder] = useState<string | null>(null);
  const [pdfCount, setPdfCount] = useState(0);
  const [rubric, setRubric] = useState('');
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loadingChats, setLoadingChats] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Esc-to-close + body scroll lock — mirrors existing modal patterns.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submitting, onClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  async function pickFolder(): Promise<void> {
    setErr(null);
    try {
      const sel = await openFolderDialog({ directory: true, multiple: false });
      if (typeof sel !== 'string') return; // user cancelled
      setFolder(sel);
      // `list_dir_local` takes `path` (verified in mac_tools.rs).
      const names = (await invoke<string[]>('list_dir_local', { path: sel })) ?? [];
      setPdfCount(names.filter(isCountedPdf).length);
    } catch (e) {
      setErr(`Falha ao listar pasta: ${String(e)}`);
      setPdfCount(0);
    }
  }

  async function loadChats(): Promise<void> {
    setErr(null);
    setLoadingChats(true);
    try {
      const list = await listChats();
      setChats(list);
    } catch (e) {
      setErr(`Falha ao carregar contatos: ${String(e)}`);
    } finally {
      setLoadingChats(false);
    }
  }

  async function submit(): Promise<void> {
    if (!folder || !chatId || rubric.trim().length < MIN_RUBRIC) return;
    setSubmitting(true);
    setErr(null);
    try {
      // Tauri zip command — matches the `folder_path` arg name in
      // `cv_triage_zip.rs`. (Tauri auto-camelCases Rust snake_case args,
      // so we pass `folderPath` from JS.)
      const zipBytes = await invoke<number[]>('zip_folder_pdfs', {
        folderPath: folder,
      });
      const label =
        chats.find((c) => c.id === chatId)?.name ?? chatId;
      const { job_id } = await createJob({
        zip: new Uint8Array(zipBytes),
        rubric: rubric.trim(),
        target_chat_id: chatId,
        target_label: label,
      });
      // Cache the source folder so the Trabalhos tab (Task 19) can open
      // the original PDF for each Top-5 entry without re-prompting.
      sessionStorage.setItem(`cv_triage:job_${job_id}_folder`, folder);
      onCreated(job_id);
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
    } finally {
      setSubmitting(false);
    }
  }

  // Groups first, then 1:1 — recruiters typically send to a group.
  const visibleChats = chats
    .filter((c) =>
      c.name.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => Number(b.isGroup) - Number(a.isGroup));

  const canNextStep1 = !!folder && pdfCount > 0;
  const canNextStep2 = rubric.trim().length >= MIN_RUBRIC;
  const canSubmit = !!chatId && !submitting;

  return createPortal(
    <div
      className="password-modal-backdrop"
      onClick={submitting ? undefined : onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cvt-title"
    >
      <div
        className="cvt-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="te__header">
          <span id="cvt-title" className="te__title" style={{ cursor: 'default' }}>
            Triagem de CV — passo {step}/3
          </span>
          <div className="te__actions">
            <button
              type="button"
              className="te__action"
              onClick={onClose}
              disabled={submitting}
              title="Fechar"
              aria-label="Fechar"
            >
              <XIcon size={16} />
            </button>
          </div>
        </div>

        {step === 1 && (
          <div className="cvt-section">
            <p className="cvt-help">
              Selecione a pasta que contém os PDFs dos candidatos. A triagem ignora arquivos que não sejam PDF (e ruído do Finder como <code>.DS_Store</code>).
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={pickFolder}
              disabled={submitting}
            >
              {folder ? 'Trocar pasta…' : 'Escolher pasta…'}
            </button>
            {folder && (
              <p className="cvt-meta">
                <code className="cvt-path">{folder}</code>
                <span>
                  · {pdfCount} PDF{pdfCount === 1 ? '' : 's'} detectado{pdfCount === 1 ? '' : 's'}
                </span>
              </p>
            )}
            {folder && pdfCount === 0 && (
              <p className="cvt-warn">
                Nenhum PDF nessa pasta. Escolha outra.
              </p>
            )}
            {err && <p className="cvt-error">{err}</p>}
            <div className="cvt-footer">
              <span />
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canNextStep1}
                onClick={() => setStep(2)}
              >
                Próximo
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="cvt-section">
            <p className="cvt-help">
              Descreva a vaga: cargo, nível, skills obrigatórias, diferenciais, localização, idiomas. Quanto mais específico, melhor o ranking.
            </p>
            <textarea
              className="cvt-textarea"
              placeholder="Ex: Desenvolvedor Python pleno, FastAPI/Django, PostgreSQL, AWS. Diferencial: experiência com LLMs. Remoto, PJ."
              value={rubric}
              onChange={(e) => setRubric(e.target.value)}
              rows={8}
              autoFocus
            />
            <p className="cvt-meta">
              {rubric.trim().length} / {MIN_RUBRIC} caracteres mínimos
            </p>
            {err && <p className="cvt-error">{err}</p>}
            <div className="cvt-footer">
              <button
                type="button"
                className="btn"
                onClick={() => setStep(1)}
              >
                Voltar
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canNextStep2}
                onClick={async () => {
                  await loadChats();
                  setStep(3);
                }}
              >
                Próximo
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="cvt-section">
            <p className="cvt-help">
              Para quem o Top-5 deve ser enviado no WhatsApp?
            </p>
            <input
              type="text"
              className="cvt-search"
              placeholder="Buscar grupo ou contato…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            <ul className="cvt-chats" role="listbox" aria-label="Destinatário">
              {loadingChats && <li className="cvt-chats__loading">Carregando contatos…</li>}
              {!loadingChats && visibleChats.length === 0 && (
                <li className="cvt-chats__empty">Nenhum contato encontrado.</li>
              )}
              {!loadingChats &&
                visibleChats.map((c) => {
                  const selected = chatId === c.id;
                  return (
                    <li
                      key={c.id}
                      role="option"
                      aria-selected={selected}
                      className={`cvt-chat${selected ? ' cvt-chat--selected' : ''}`}
                      onClick={() => setChatId(c.id)}
                    >
                      <span className={`cvt-chat__type${c.isGroup ? ' cvt-chat__type--group' : ''}`}>
                        {c.isGroup ? 'GRUPO' : '1:1'}
                      </span>
                      <span className="cvt-chat__name">{c.name}</span>
                    </li>
                  );
                })}
            </ul>
            {err && <p className="cvt-error">{err}</p>}
            <div className="cvt-footer">
              <button
                type="button"
                className="btn"
                onClick={() => setStep(2)}
                disabled={submitting}
              >
                Voltar
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canSubmit}
                onClick={submit}
              >
                {submitting ? 'Enviando…' : 'Enviar'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
