import type { ReactNode } from 'react';

/** Contêiner das telas "empurradas" (Memória, Calendário, Insights, Lição,
 *  WhatsApp thread…): SEM chrome.
 *
 *  O handoff desenha o cabeçalho DENTRO de cada tela, e cada uma do seu jeito —
 *  a Lição tem X + barra de progresso + pill "Teoria", o WhatsApp tem avatar e
 *  "online", a Memória tem campo de busca. Um cabeçalho genérico aqui (‹ +
 *  título) duplicava o da tela e impedia as que não são "‹ + título" de bater
 *  com o desenho. Então a tela é dona do cabeçalho inteiro, o ‹ inclusive —
 *  o `onBack` chega nela pelo `ScreenProps`.
 *
 *  O que sobra aqui é layout que nenhuma tela deve reinventar: altura cheia,
 *  rolagem e as safe areas (topo e home indicator) — ver `.mpushed`/
 *  `.mpushed__body` em obsidian.css. */
export function PushedScreen({ children }: { children: ReactNode }) {
  return (
    <div className="mpushed">
      <div className="mpushed__body">{children}</div>
    </div>
  );
}
