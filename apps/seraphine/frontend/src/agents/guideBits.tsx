/** Small pieces of phase 6c shared by the proposal cards and the agent history: collapsible long text and the before/after view. */
import { useId, useState } from 'react';
import { COLLAPSE_AFTER } from './guide';
import type { DiffRow } from './guide';
import { ClockIcon, HourglassIcon, RestartIcon, StopIcon, TickIcon } from './icons';
import { WarningIcon } from './setupIcons';
import { PROPOSAL_STATE_WORDS } from './guide';
import type { ProposalStatus } from './types';

/** Text as plain paragraphs (React text nodes, never HTML); a long one is folded behind "Ver o texto inteiro". */
export function LongText({ text, id }: { text: string; id?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const own = useId();
  const bodyId = id ?? own;
  const long = text.length > COLLAPSE_AFTER;
  const shown = long && !open ? `${text.slice(0, COLLAPSE_AFTER).trimEnd()}…` : text;
  return (
    <div className="a-longtext">
      <p className="a-longtext__body" id={bodyId}>
        {shown}
      </p>
      {long && (
        <button type="button" className="a-link" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
          {open ? 'Ver menos' : 'Ver o texto inteiro'}
        </button>
      )}
    </div>
  );
}

function DiffSide({ tag, lines, list, open, bodyId }: { tag: 'Antes' | 'Depois'; lines: string[] | null; list: boolean; open: boolean; bodyId: string }): JSX.Element {
  const tagId = useId();
  let body: JSX.Element;
  if (lines === null) {
    body = <p className="a-diff__none">Não informado</p>;
  } else if (list) {
    body =
      lines.length === 0 ? (
        <p className="a-diff__none">Nenhuma</p>
      ) : (
        <ul className="a-bullets a-diff__list">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      );
  } else {
    const text = lines.join('\n');
    const shown = text.length > COLLAPSE_AFTER && !open ? `${text.slice(0, COLLAPSE_AFTER).trimEnd()}…` : text;
    body = text === '' ? <p className="a-diff__none">Vazio</p> : <p className="a-diff__text" id={bodyId}>{shown}</p>;
  }
  return (
    <div className={`a-diff__side a-diff__side--${tag === 'Antes' ? 'before' : 'after'}`} role="group" aria-labelledby={tagId}>
      <span className="a-diff__tag" id={tagId}>
        {tag}
      </span>
      {body}
    </div>
  );
}

/** One changed field: what it was ("Antes") and what it becomes ("Depois"), labelled for a screen reader; a long text is folded. */
export function FieldDiff({ row }: { row: DiffRow }): JSX.Element {
  const [open, setOpen] = useState(false);
  const base = useId();
  const labelId = `${base}-label`;
  const long = !row.list && [...(row.before ?? []), ...row.after].join('\n').length > COLLAPSE_AFTER;
  return (
    <section className="a-diff" aria-labelledby={labelId}>
      <strong className="a-diff__label" id={labelId}>
        {row.label}
      </strong>
      <div className="a-diff__cols">
        <DiffSide tag="Antes" lines={row.before} list={row.list} open={open} bodyId={`${base}-before`} />
        <DiffSide tag="Depois" lines={row.after} list={row.list} open={open} bodyId={`${base}-after`} />
      </div>
      {long && (
        <button type="button" className="a-link a-diff__more" aria-expanded={open} aria-controls={`${base}-before ${base}-after`} onClick={() => setOpen((v) => !v)}>
          {open ? 'Ver menos' : 'Ver o texto inteiro'}
        </button>
      )}
    </section>
  );
}

const STATE_TONE: Record<ProposalStatus, 'busy' | 'ok' | 'dim' | 'warn'> = {
  pending: 'busy',
  applied: 'ok',
  dismissed: 'dim',
  expired: 'dim',
  stale: 'warn',
  failed: 'warn',
};

/** The state of a proposal: icon and word, never colour alone. */
export function ProposalChip({ status }: { status: ProposalStatus }): JSX.Element {
  const icon =
    status === 'pending' ? (
      <ClockIcon size={12} />
    ) : status === 'applied' ? (
      <TickIcon size={12} />
    ) : status === 'dismissed' ? (
      <StopIcon size={10} />
    ) : status === 'expired' ? (
      <HourglassIcon size={12} />
    ) : status === 'stale' ? (
      <RestartIcon size={12} />
    ) : (
      <WarningIcon size={12} />
    );
  return (
    <span className={`a-chip a-prop-chip a-prop-chip--${STATE_TONE[status]}`}>
      {icon}
      {PROPOSAL_STATE_WORDS[status]}
    </span>
  );
}
