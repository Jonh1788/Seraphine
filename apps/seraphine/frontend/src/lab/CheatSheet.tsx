/**
 * Popover de atalhos de teclado do Animation Lab.
 */
import { useEffect } from 'react';

export const CHEATS: { keys: string; label: string }[] = [
  { keys: 'Space', label: 'Play / Pause' },
  { keys: 'I', label: 'Inserir keyframe no scrub' },
  { keys: '<- ->', label: 'Passo de 1 frame (1/60s)' },
  { keys: 'Shift + <- ->', label: 'Pular ao proximo keyframe' },
  { keys: 'Ctrl + wheel', label: 'Zoom na timeline' },
  { keys: 'Shift + drag', label: 'Snap-to-grid / rubber-band' },
  { keys: 'Alt + drag', label: 'Sub-tick snap' },
  { keys: 'Ctrl + Z / Shift+Z', label: 'Undo / Redo' },
  { keys: 'Ctrl + C / X / V', label: 'Copy / Cut / Paste' },
  { keys: 'Ctrl + A', label: 'Selecionar todos' },
  { keys: 'Ctrl + S', label: 'Salvar' },
  { keys: 'Delete', label: 'Apagar selecionado' },
  { keys: 'Esc', label: 'Limpar selecao / fechar' },
];

export function CheatSheet({ onClose }: { onClose: () => void }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="anim-lab__cheatsheet" onClick={e => e.stopPropagation()}>
      <h4>Atalhos</h4>
      {CHEATS.map(c => (
        <div key={c.keys} className="anim-lab__cheatsheet-row">
          <span className="anim-lab__cheatsheet-key">{c.keys}</span>
          <span>{c.label}</span>
        </div>
      ))}
    </div>
  );
}
