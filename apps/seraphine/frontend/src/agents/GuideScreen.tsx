/**
 * The conversation with the Seraphine (phase 6c part 1, contract 4.1): the owner asks for changes and she answers with proposal
 * cards. Nothing changes before the owner's click on a card. The model's text is shown as plain text, never as HTML.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { EmptyNote, Notice } from './components';
import { SendIcon } from '../icons/Icons';
import { ProposalCard } from './ProposalCard';
import { SeraphineSays } from './TeamBuilder';
import { aboutLabel, guideSuggestions } from './guide';
import { formatTime } from './lib';
import { useAgentsStore } from './store';
import type { GuideAbout, GuideMessage } from './types';
import { GUIDE_BODY_MAX } from './types';
import { useConfirm } from '../ui';
import seraphineLogo from '../../src-tauri/icons/128x128.png';

export const GUIDE_LINE = 'Ela propõe, você decide. Nada muda antes do seu clique.';
export const GUIDE_WELCOME = 'Oi! Eu monto e ajusto os seus agentes e as rotinas deles. Me conte o que você quer e eu mostro uma proposta. Você confere e decide se aplica.';

function SeraphineMessage({ message }: { message: GuideMessage }): JSX.Element {
  const proposals = useAgentsStore((s) => s.guideProposals);
  const cards = message.proposal_ids.map((id) => proposals[id]).filter((p) => !!p);
  return (
    <article className="a-msg">
      <img src={seraphineLogo} alt="" aria-hidden="true" className="a-says__mark" />
      <div className="a-msg__main">
        <div className="a-msg__meta">
          <strong>Seraphine</strong>
          <span>{formatTime(message.created_at)}</span>
        </div>
        <p className="a-msg__text">{message.body}</p>
        {cards.length > 0 && (
          <div className="a-guide__proposals">
            {cards.map((p) => (
              <ProposalCard key={p.id} proposal={p} />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

export function GuideScreen(): JSX.Element {
  const route = useAgentsStore((s) => s.route);
  const messages = useAgentsStore((s) => s.guideMessages);
  const state = useAgentsStore((s) => s.guideState);
  const outbox = useAgentsStore((s) => s.guideOutbox);
  const agents = useAgentsStore((s) => s.agents);
  const routines = useAgentsStore((s) => s.routines);
  const loadGuide = useAgentsStore((s) => s.loadGuide);
  const sendGuide = useAgentsStore((s) => s.sendGuide);
  const retryGuide = useAgentsStore((s) => s.retryGuide);
  const clearGuide = useAgentsStore((s) => s.clearGuide);
  const navigate = useAgentsStore((s) => s.navigate);
  const confirm = useConfirm();

  // The entry point (an agent, a routine) fills the composer once, when the screen opens.
  const [text, setText] = useState(route.prefill ?? '');
  const [about, setAbout] = useState<GuideAbout | undefined>(route.about);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const aboutId = useId();

  useEffect(() => {
    if (useAgentsStore.getState().guideState !== 'ready') void loadGuide();
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sending = outbox?.phase === 'sending';
  const entries = messages.length + (outbox ? 1 : 0);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, sending]);

  const suggestions = useMemo(() => guideSuggestions(agents, routines), [agents, routines]);
  const aboutText = aboutLabel(about, agents, routines);

  const fill = (value: string): void => {
    setText((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${value}` : value));
    inputRef.current?.focus();
  };

  const submit = async (): Promise<void> => {
    const body = text.trim();
    if (!body || sending) return;
    const sentAbout = about;
    setNotice(null);
    setText('');
    // `about` travels with this message only.
    setAbout(undefined);
    const res = await sendGuide(body, sentAbout);
    if (res.ok) return;
    // A 503 keeps the message in the conversation (with "Tentar de novo"); any other refusal gives the text back, still not sent.
    if (useAgentsStore.getState().guideOutbox?.phase === 'failed') return;
    setText((cur) => (cur.trim() ? `${body}\n\n${cur}` : body));
    setAbout((cur) => cur ?? sentAbout);
    if (res.error) setNotice(res.error);
  };

  const clear = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Limpar a conversa',
      message: 'Apagar as mensagens e as propostas que ainda não foram aplicadas? O que já foi aplicado continua no histórico dos agentes.',
      confirmLabel: 'Limpar conversa',
      variant: 'danger',
    });
    if (!ok) return;
    setNotice(null);
    const res = await clearGuide();
    if (!res.ok) setNotice(res.error ?? 'Não consegui limpar a conversa agora. Tente de novo.');
  };

  if (state === 'unavailable') {
    return (
      <div className="a-page">
        <EmptyNote>A conversa com a Seraphine ainda não está disponível nesta versão.</EmptyNote>
        <button type="button" className="a-btn a-btn--ghost" onClick={() => navigate({ screen: 'home' })}>
          Voltar ao início
        </button>
      </div>
    );
  }

  const empty = messages.length === 0 && !outbox;
  let thread: JSX.Element;
  if (empty) {
    thread = (
      <div className="a-thread a-thread--empty" ref={listRef}>
        {state === 'loading' || state === 'idle' ? (
          <p className="a-empty" role="status">
            Carregando a conversa…
          </p>
        ) : state === 'error' ? (
          <Notice>
            Não consegui carregar a conversa.{' '}
            <button type="button" className="a-link" onClick={() => void loadGuide()}>
              Tentar de novo
            </button>
          </Notice>
        ) : (
          <div className="a-guide__empty">
            <SeraphineSays>{GUIDE_WELCOME}</SeraphineSays>
            <div className="a-suggestions" role="group" aria-label="Pedidos para começar">
              {suggestions.map((s) => (
                <button key={s} type="button" className="a-chip-btn" onClick={() => fill(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  } else {
    thread = (
      <div className="a-thread" ref={listRef} role="log" aria-label="Conversa com a Seraphine">
        {messages.map((m) =>
          m.author === 'owner' ? (
            <div className="a-msg a-msg--user" key={m.id}>
              <div className="a-msg__user">
                <div className="a-bubble">{m.body}</div>
              </div>
            </div>
          ) : (
            <SeraphineMessage key={m.id} message={m} />
          ),
        )}
        {outbox && (
          <div className="a-msg a-msg--user">
            <div className="a-msg__user">
              <div className="a-bubble">{outbox.text}</div>
              {outbox.phase === 'failed' && (
                <Notice>
                  {outbox.error}{' '}
                  <button type="button" className="a-link" onClick={() => void retryGuide()}>
                    Tentar de novo
                  </button>
                </Notice>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="a-page a-page--fill">
      <header className="a-header a-guide__head">
        <img src={seraphineLogo} alt="" aria-hidden="true" className="a-guide__mark" />
        <div className="a-header__text">
          <h1>Seraphine</h1>
          <span>{GUIDE_LINE}</span>
        </div>
        {!empty && (
          <button type="button" className="a-btn a-btn--ghost a-btn--small" onClick={() => void clear()}>
            Limpar conversa
          </button>
        )}
      </header>

      <section className="a-chat a-guide" aria-label="Conversa com a Seraphine">
        {thread}
        <div className="a-guide__live" role="status" aria-live="polite">
          {sending ? 'A Seraphine está pensando…' : ''}
        </div>
        {notice && <Notice>{notice}</Notice>}
        <div className="a-composer">
          {aboutText && (
            <div className="a-guide__about">
              <span className="a-chip a-about-chip" id={aboutId}>
                {aboutText}
              </span>
              <button type="button" className="a-link" aria-describedby={aboutId} onClick={() => setAbout(undefined)}>
                Tirar o assunto
              </button>
            </div>
          )}
          <label className="a-composer__field">
            <span className="sr-only">Mensagem para a Seraphine</span>
            <textarea
              ref={inputRef}
              className="a-composer__input"
              rows={2}
              maxLength={GUIDE_BODY_MAX}
              value={text}
              placeholder="Escreva o que você quer mudar ou criar"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </label>
          <div className="a-composer__bar">
            <span className="a-spacer" />
            <button type="button" className="a-send" aria-label="Enviar" disabled={sending || !text.trim()} onClick={() => void submit()}>
              <SendIcon size={18} />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
