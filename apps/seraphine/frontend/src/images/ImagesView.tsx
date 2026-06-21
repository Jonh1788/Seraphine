/**
 * 068 -- Gallery of generated images.
 *
 * Lists everything in /images, click to open full-size in a lightbox.
 * The "Gerar imagem" / "Gerar nova" CTAs open an in-app prompt modal that
 * POSTs to the real generation endpoint and refreshes the grid on success.
 * Accessible from main app sidebar.
 */

import './obsidian.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../api';
import { SparkleIcon } from '../icons/Icons';

interface GeneratedImage {
  id: string;
  prompt: string;
  model: string;
  url: string | null;
  cost_usd: number;
  created_at: string;
}

interface ImagesViewProps {
  // Kept for the navigation contract from AppLayout (route back to chat).
  // Generation now happens in-app via the prompt modal, so the CTAs no
  // longer call this directly, but the prop remains part of the contract.
  onBack?: () => void;
}

type ViewStatus = 'loading' | 'error' | 'empty' | 'loaded';

/** Quality presets mapped to the backend `quality` param. */
const QUALITY_OPTIONS: { value: string; label: string }[] = [
  { value: 'fast', label: 'Rápida' },
  { value: 'high', label: 'Alta' },
];

/** Strip a provider path (e.g. "black-forest-labs/flux-schnell") down to a
 *  short, human-readable model name for the badge. */
function shortModelName(model: string): string {
  if (!model) return '';
  const tail = model.split('/').pop() ?? model;
  return tail;
}

export function ImagesView(_props: ImagesViewProps): JSX.Element {
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [viewStatus, setViewStatus] = useState<ViewStatus>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [lightbox, setLightbox] = useState<string | null>(null);

  // Generation modal state.
  const [modalOpen, setModalOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [quality, setQuality] = useState('fast');
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState('');

  const fetchImages = useCallback(async () => {
    setViewStatus('loading');
    setErrorMsg('');
    try {
      const res = await fetch(`${API_BASE}/images?limit=100`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { images: GeneratedImage[] };
      const imgs = data.images || [];
      setImages(imgs);
      setViewStatus(imgs.length > 0 ? 'loaded' : 'empty');
    } catch {
      setImages([]);
      setErrorMsg('Nao consegui carregar as imagens.');
      setViewStatus('error');
    }
  }, []);

  useEffect(() => { void fetchImages(); }, [fetchImages]);

  // Today's spend, derived client-side from the already-fetched list:
  // sum cost_usd of images created today (UTC date, matching the
  // backend's cost_today() which keys on the UTC created_at prefix).
  const spentToday = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return images.reduce((sum, img) => {
      if ((img.created_at || '').slice(0, 10) === today) {
        return sum + (Number(img.cost_usd) || 0);
      }
      return sum;
    }, 0);
  }, [images]);

  const openGenerate = useCallback(() => {
    setGenError('');
    setModalOpen(true);
  }, []);

  const closeGenerate = useCallback(() => {
    if (generating) return;
    setModalOpen(false);
    setPrompt('');
    setGenError('');
  }, [generating]);

  const submitGenerate = useCallback(async () => {
    const trimmed = prompt.trim();
    if (trimmed.length < 2) {
      setGenError('Descreva a imagem (mínimo 2 caracteres).');
      return;
    }
    setGenerating(true);
    setGenError('');
    try {
      const res = await fetch(`${API_BASE}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmed, quality }),
      });
      if (!res.ok) {
        // Backend returns 503 (budget/key) or 502 (provider) with a
        // `detail` message — surface it instead of a generic error.
        let detail = `HTTP ${res.status}`;
        try {
          const errBody = await res.json() as { detail?: string };
          if (errBody.detail) detail = errBody.detail;
        } catch { /* keep generic */ }
        throw new Error(detail);
      }
      // POST /images responds with an envelope: { image: { id, ... } }.
      // (Reading the bare object here would silently drop the result.)
      await res.json() as { image: GeneratedImage };
      setModalOpen(false);
      setPrompt('');
      // The new image is persisted to the same table GET reads, so a
      // refresh is enough to show it at the top of the grid.
      await fetchImages();
    } catch (e) {
      setGenError(e instanceof Error ? e.message : 'Falha ao gerar a imagem.');
    } finally {
      setGenerating(false);
    }
  }, [prompt, quality, fetchImages]);

  const renderSkeletonTiles = (): JSX.Element[] =>
    Array.from({ length: 8 }).map((_, i) => (
      <div key={`sk-${i}`} className="fc-skeleton images-skeleton" />
    ));

  return (
    <div className="images-screen">
      <div className="images-screen__header">
        <div>
          <div className="images-screen__title">Imagens</div>
          <div className="images-screen__sub">
            Geradas com IA · {images.length} criações
            {spentToday > 0 && (
              <span className="images-spend-chip" title="Gasto estimado hoje">
                <SparkleIcon size={11} />
                ${spentToday.toFixed(2)} hoje
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            className="btn btn-ghost images-refresh"
            aria-label="Atualizar"
            disabled={viewStatus === 'loading'}
            onClick={() => void fetchImages()}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
          <button type="button" className="images-cta" onClick={openGenerate}>
            <SparkleIcon size={14} />
            Gerar imagem
          </button>
        </div>
      </div>

      <div className="images-screen__body">
        {viewStatus === 'loading' && renderSkeletonTiles()}

        {viewStatus === 'error' && (
          <div className="images-state">
            <div className="images-state__msg images-state__msg--error">{errorMsg}</div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void fetchImages()}
            >
              Tentar de novo
            </button>
          </div>
        )}

        {viewStatus === 'empty' && (
          <div className="images-state">
            <div className="images-state__msg">
              Nenhuma imagem ainda. Clique em "Gerar nova" para criar a primeira.
            </div>
            <div
              role="button"
              tabIndex={0}
              className="images-tile--new"
              style={{ width: 200, height: 182 }}
              onClick={openGenerate}
            >
              <SparkleIcon size={24} />
              <span>Gerar nova</span>
            </div>
          </div>
        )}

        {viewStatus === 'loaded' && (
          <>
            {images.map((img) => {
              const src = `${API_BASE}/images/${img.id}`;
              const badge = shortModelName(img.model);
              return (
                <div
                  key={img.id}
                  className="images-tile"
                  onClick={() => setLightbox(src)}
                >
                  {badge && <span className="images-tile__badge">{badge}</span>}
                  <img
                    className="images-tile__img"
                    src={src}
                    alt={img.prompt}
                  />
                  <div className="images-tile__scrim" />
                  <span className="images-tile__caption">{img.prompt}</span>
                </div>
              );
            })}
            <div
              role="button"
              tabIndex={0}
              className="images-tile--new"
              onClick={openGenerate}
            >
              <SparkleIcon size={24} />
              <span>Gerar nova</span>
            </div>
          </>
        )}
      </div>

      {modalOpen && (
        <div className="images-modal-backdrop" onClick={closeGenerate}>
          <div className="images-modal" onClick={(e) => e.stopPropagation()}>
            <div className="images-modal__title">Gerar imagem</div>
            <textarea
              className="images-modal__textarea"
              placeholder='Descreva a imagem. Ex: "um gato astronauta em aquarela"'
              value={prompt}
              autoFocus
              disabled={generating}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="images-modal__row">
              <span className="images-modal__label">Qualidade</span>
              <select
                className="images-modal__select"
                value={quality}
                disabled={generating}
                onChange={(e) => setQuality(e.target.value)}
              >
                {QUALITY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            {genError && <div className="images-modal__error">{genError}</div>}
            <div className="images-modal__actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={generating}
                onClick={closeGenerate}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="images-cta"
                disabled={generating}
                onClick={() => void submitGenerate()}
              >
                <SparkleIcon size={14} />
                {generating ? 'Gerando…' : 'Gerar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {lightbox && (
        <div
          className="images-lightbox"
          onClick={() => setLightbox(null)}
        >
          <img
            className="images-lightbox__img"
            src={lightbox}
            alt=""
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
