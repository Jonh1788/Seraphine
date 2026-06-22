import { useMemo, useState } from 'react';
import { useSkillsStore } from './skillsStore';
import type { SkillDraft } from './types';

// ---- inline SVG icons (Lucide-style, no emojis) ----
const sk = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const IconSparkle = (): JSX.Element => <svg width="14" height="14" viewBox="0 0 24 24" {...sk} strokeWidth={1.8}><path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4z" /></svg>;
const IconCheck = (): JSX.Element => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>;
const IconTrash = (): JSX.Element => <svg width="13" height="13" viewBox="0 0 24 24" {...sk} strokeWidth={1.8}><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>;

/** Status badge color class — mirrors si-history__badge--* semantics. */
const STATUS_LABEL: Record<SkillDraft['status'], string> = {
  draft: 'rascunho',
  published: 'publicada',
  discarded: 'descartada',
};

/** dd/mm HH:MM — same compact format SelfImprove uses for run history. */
function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function SkillsPanel(): JSX.Element {
  const drafts = useSkillsStore((s) => s.drafts);
  const publish = useSkillsStore((s) => s.publish);
  const discard = useSkillsStore((s) => s.discard);
  // The id currently being published, so we can disable + spin that one row.
  const [publishing, setPublishing] = useState<string | null>(null);

  // Show drafts + published (newest first); discarded are hidden from review.
  const visible = useMemo(
    () => drafts.filter((d) => d.status !== 'discarded').sort((a, b) => b.createdAt - a.createdAt),
    [drafts],
  );

  const onPublish = async (id: string): Promise<void> => {
    setPublishing(id);
    try {
      await publish(id);
    } finally {
      setPublishing(null);
    }
  };

  return (
    <div className="obs-screen__body maestro__body maestro__body--skills">
      <div className="si-mainempty si-mainempty--skills">
        {visible.length === 0 ? (
          <>
            <span className="si-mainempty__icon"><IconSparkle /></span>
            <div className="si-mainempty__title">Nenhuma skill aprendida ainda</div>
            <div className="si-mainempty__body">
              Rode um agente no Maestro (≥2 ações) e ela aparece aqui pra revisão.
            </div>
          </>
        ) : (
          <div className="si-history">
            <div className="si-history__title">Skills aprendidas</div>
            {visible.map((d) => {
              const pct = Math.round(d.confidence * 100);
              const pending = publishing === d.id;
              return (
                <details key={d.id} className="si-history__item">
                  <summary className="si-history__row">
                    <span className={`si-history__badge si-history__badge--${d.status === 'published' ? 'merged' : 'interrupted'}`}>
                      {STATUS_LABEL[d.status]}
                    </span>
                    <span className="si-history__goal">{d.name}</span>
                    <span className="si-history__meta">{pct}% · {fmtDate(d.createdAt)}</span>
                  </summary>
                  <div className="sk-body">
                    <pre className="sk-md">{d.skillMd}</pre>
                    <div className="sk-foot">
                      <span className="si-dim">agente <code className="si-mono">{d.sourceAgentId.slice(0, 8)}</code> · {fmtDate(d.createdAt)}</span>
                    </div>
                    {d.status === 'published' ? (
                      d.publishedPath && (
                        <div className="sk-published">
                          <IconCheck />
                          <code className="si-mono">{d.publishedPath}</code>
                        </div>
                      )
                    ) : (
                      <div className="sk-actions">
                        <button
                          type="button"
                          className="si-btn si-btn--merge"
                          disabled={pending}
                          onClick={() => { void onPublish(d.id); }}
                        >
                          {pending ? <><span className="si-spinner" aria-hidden />Publicando…</> : <><IconCheck />Publicar</>}
                        </button>
                        <button
                          type="button"
                          className="si-btn si-btn--reject"
                          disabled={pending}
                          onClick={() => discard(d.id)}
                        >
                          <IconTrash />Descartar
                        </button>
                      </div>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
