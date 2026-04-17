/**
 * 068 — Gallery of generated images.
 *
 * Lists everything in /images, click to open full-size in a lightbox.
 * Accessible from main app sidebar.
 */

import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from '../api';

interface GeneratedImage {
  id: string;
  prompt: string;
  model: string;
  url: string | null;
  cost_usd: number;
  created_at: string;
}

interface ImagesViewProps {
  onBack: () => void;
}

export function ImagesView({ onBack }: ImagesViewProps): JSX.Element {
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const fetchImages = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/images?limit=100`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { images: GeneratedImage[] };
      setImages(data.images || []);
    } catch {
      setImages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchImages(); }, [fetchImages]);

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <button
          type="button"
          onClick={onBack}
          style={{
            background: 'transparent', border: '1px solid rgba(255,255,255,0.15)',
            color: 'inherit', padding: '6px 12px', borderRadius: 8,
            cursor: 'pointer', fontSize: 13,
          }}
        >
          ← voltar
        </button>
        <h2 style={{ margin: 0, fontSize: 18 }}>Imagens geradas</h2>
        <button
          type="button"
          onClick={() => void fetchImages()}
          style={{
            background: 'transparent', border: '1px solid rgba(255,255,255,0.15)',
            color: 'inherit', padding: '6px 12px', borderRadius: 8,
            cursor: 'pointer', fontSize: 13, marginLeft: 'auto',
          }}
        >
          {loading ? 'atualizando…' : 'atualizar'}
        </button>
      </div>

      {images.length === 0 && !loading && (
        <div style={{ opacity: 0.6, textAlign: 'center', paddingTop: 60 }}>
          Nenhuma imagem ainda. Peça uma na conversa: "gera uma ilustração de…"
        </div>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 12,
      }}>
        {images.map((img) => {
          const src = `${API_BASE}/images/${img.id}`;
          return (
            <div
              key={img.id}
              onClick={() => setLightbox(src)}
              style={{
                position: 'relative',
                background: 'rgba(255,255,255,0.04)',
                borderRadius: 10,
                overflow: 'hidden',
                cursor: 'zoom-in',
                aspectRatio: '4 / 3',
              }}
            >
              <img
                src={src}
                alt={img.prompt}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              <div style={{
                position: 'absolute', inset: 'auto 0 0 0',
                padding: '8px 10px',
                background: 'linear-gradient(to top, rgba(0,0,0,0.75), transparent)',
                fontSize: 11,
                color: 'white',
              }}>
                {img.prompt.slice(0, 80)}
                {img.prompt.length > 80 ? '…' : ''}
              </div>
            </div>
          );
        })}
      </div>

      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.85)', zIndex: 10000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'zoom-out',
            backdropFilter: 'blur(4px)',
          }}
        >
          <img
            src={lightbox}
            alt=""
            style={{
              maxWidth: '92vw', maxHeight: '92vh',
              borderRadius: 8,
              boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
            }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
