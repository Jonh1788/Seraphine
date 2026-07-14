import type { ReactNode } from 'react';
import { ArrowLeftIcon } from '../icons/Icons';

export function PushedScreen({ title, onBack, children }:
  { title: string; onBack: () => void; children: ReactNode }) {
  return (
    <div className="mpushed">
      <header className="mpushed__head">
        <button type="button" className="mpushed__back" onClick={onBack} aria-label="Voltar">
          <ArrowLeftIcon size={20} />
        </button>
        <span className="mpushed__title">{title}</span>
      </header>
      <div className="mpushed__body">{children}</div>
    </div>
  );
}
