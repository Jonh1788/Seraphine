/** State chip of an engine: icon plus word, never colour alone. */
import { useId } from 'react';
import { TickIcon } from './icons';
import { WarningIcon } from './setupIcons';

export function EngineChip({
  ready,
  word,
  how,
}: {
  ready: boolean;
  /** Overrides the default word (`Pronto` / `Sem motor`). */
  word?: string;
  /** Sentence read as the chip's description when it is not ready (also a tooltip). */
  how?: string;
}): JSX.Element {
  const descId = useId();
  const text = word ?? (ready ? 'Pronto' : 'Sem motor');
  return (
    <>
      <span
        className={`a-chip a-chip--engine ${ready ? 'a-chip--ok' : 'a-chip--warn'}`}
        title={!ready && how ? how : undefined}
        aria-describedby={!ready && how ? descId : undefined}
      >
        {ready ? <TickIcon size={12} /> : <WarningIcon size={12} />}
        {text}
      </span>
      {!ready && how && (
        <span className="sr-only" id={descId}>
          {how}
        </span>
      )}
    </>
  );
}
