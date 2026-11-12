/**
 * "Apagar" an agent for good: a dialog that lists what goes and what stays, and only enables the button after the owner typed
 * the agent's name exactly. Used by the "Sobre" tab and by the archived list of the roster.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Notice } from './components';
import { DELETE_GOES, DELETE_STAYS, nameMatches } from './agentPage';
import { useAgentsStore } from './store';

export function DeleteAgentDialog({
  agentId,
  name,
  onClose,
  onDeleted,
}: {
  agentId: string;
  name: string;
  onClose: () => void;
  onDeleted: () => void;
}): JSX.Element {
  const deleteAgent = useAgentsStore((s) => s.deleteAgent);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const inputId = useId();
  const panelRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const matches = nameMatches(typed, name);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>('button, input')].filter((el) => !(el as HTMLButtonElement).disabled);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!matches || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const res = await deleteAgent(agentId);
    inFlight.current = false;
    setBusy(false);
    if (res.ok) onDeleted();
    else setError(res.error ?? `Não consegui apagar ${name}. Se ele estiver trabalhando, espere terminar e tente de novo.`);
  };

  return (
    <div className="a-dialog" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="a-dialog__panel a-dialog__panel--narrow" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef} onSubmit={(e) => void submit(e)}>
        <header className="a-dialog__head">
          <h2 id={titleId}>{`Apagar ${name}`}</h2>
        </header>
        <p>Apagar é definitivo e não pode ser desfeito. Se você só quer tirar {name} do caminho, use Arquivar: nada se perde.</p>
        <div className="a-delete__lists">
          <section aria-label="O que sai">
            <p className="a-label-text">O que sai</p>
            <ul className="a-bullets">
              {DELETE_GOES.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
          <section aria-label="O que fica">
            <p className="a-label-text">O que fica</p>
            <ul className="a-bullets">
              {DELETE_STAYS.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        </div>
        <div className="a-field">
          <label htmlFor={inputId}>{`Para confirmar, digite o nome do agente: ${name}`}</label>
          <input id={inputId} ref={inputRef} className="a-input" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
        </div>
        {error && <Notice>{error}</Notice>}
        <div className="a-actions a-actions--end">
          <span className="a-spacer" />
          <button type="button" className="a-btn a-btn--ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="a-btn a-btn--danger" disabled={!matches || busy}>
            {busy ? 'Apagando…' : 'Apagar agente'}
          </button>
        </div>
      </form>
    </div>
  );
}
