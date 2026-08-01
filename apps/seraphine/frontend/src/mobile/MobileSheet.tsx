import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as EventoDeTecla, type ReactNode } from 'react';
import './MobileSheet.css';

// A ÚNICA peça compartilhada nova da onda. Os três modais (nova tarefa, novo
// evento, nova lembrança) desenham o mesmo backdrop, o mesmo grabber, os mesmos
// cantos de 28 e o mesmo respiro de home indicator; triplicar isso repetiria o
// preço que o review da onda anterior já cobrou (16 `@keyframes` idênticos sob
// 16 nomes). Aqui mora só a MOLDURA: o conteúdo do cabeçalho, do corpo e do
// rodapé é de cada modal.
//
// O que a moldura garante, e nenhum modal precisa refazer:
//  - fechada, não deixa nada no DOM (nada de campo focável atrás do backdrop);
//  - o backdrop fecha, o conteúdo não (são irmãos, o clique não borbulha de um
//    para o outro);
//  - o rodapé fica FORA da área rolável — é onde o modal de tarefa mostra
//    salvando…/salvo/erro ao salvar, e um erro que rola para fora da tela é
//    pior que erro nenhum;
//  - o painel sobe com o teclado do iOS (ver `useEffect` da visualViewport);
//  - a rolagem do fundo trava enquanto o sheet está aberto;
//  - `role=dialog` + `aria-modal`, nome acessível, foco inicial no painel,
//    Escape fecha e o Tab circula dentro do painel.

/** O que o Tab pode alcançar dentro do painel. O próprio painel tem
 *  `tabindex="-1"` (recebe foco por código, não pelo Tab) e cai fora daqui. */
const FOCAVEIS =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type MobileSheetProps = {
  aberto: boolean;
  onFechar: () => void;
  /** Nome acessível do diálogo ("Nova tarefa", "Novo evento", …).
   *  OBRIGATÓRIO e separado de `titulo` de propósito: o cabeçalho dos modais
   *  leva Cancelar e Salvar ao lado do texto, então apontar o nome para ele
   *  faria o modal se anunciar como "Cancelar Novo evento Salvar" — e o
   *  consumidor não teria como consertar de fora. Mesmo desenho do
   *  `label` de `google/ModalShell.tsx`. */
  rotulo: string;
  /** Conteúdo do cabeçalho, logo abaixo do grabber. Cada modal desenha o dele
   *  (Cancelar/título/Salvar no evento e na lembrança, título + ações na
   *  tarefa). É só o VISÍVEL: quem nomeia o diálogo é `rotulo`. */
  titulo?: ReactNode;
  children: ReactNode;
  /** Faixa fixa no pé do painel, fora da rolagem: status de autosave, ou os
   *  botões de Cancelar/Salvar. */
  rodape?: ReactNode;
};

export function MobileSheet({ aberto, onFechar, rotulo, titulo, children, rodape }: MobileSheetProps): JSX.Element {
  const painel = useRef<HTMLDivElement>(null);
  /** Quanto do fundo da janela o teclado está cobrindo, em px. */
  const [teclado, setTeclado] = useState(0);

  // Foco inicial no painel (e não no primeiro campo): quem lê tela ouve o nome
  // do diálogo antes de cair dentro de um input sem contexto.
  useEffect(() => {
    if (aberto) painel.current?.focus();
  }, [aberto]);

  useEffect(() => {
    if (!aberto) return;
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFechar();
    };
    document.addEventListener('keydown', aoTeclar);
    return () => document.removeEventListener('keydown', aoTeclar);
  }, [aberto, onFechar]);

  // Trava a rolagem do fundo. `overscroll-behavior: contain` no corpo só corta
  // o ENCADEAMENTO a partir dele; arrastar no backdrop, ou na parte do painel
  // que não rola, ainda arrastaria a tela atrás no WKWebView. Mesmo remédio de
  // `google/ModalShell.tsx`, com o valor anterior devolvido no cleanup.
  useEffect(() => {
    if (!aberto) return;
    const antes = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = antes;
    };
  }, [aberto]);

  // TECLADO DO iOS. Ao abrir o teclado, o Safari/WKWebView encolhe a VISUAL
  // viewport mas NÃO a layout viewport — um elemento `position: fixed` colado
  // embaixo continua onde estava, ou seja, atrás do teclado, levando o rodapé
  // junto. A diferença entre as duas viewports é exatamente a altura coberta;
  // ela vira `--ms-sheet-teclado`, que o CSS usa para subir o painel e apertar
  // a altura máxima na mesma medida.
  useEffect(() => {
    if (!aberto) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const medir = () =>
      setTeclado(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    medir();
    vv.addEventListener('resize', medir);
    vv.addEventListener('scroll', medir);
    return () => {
      vv.removeEventListener('resize', medir);
      vv.removeEventListener('scroll', medir);
    };
  }, [aberto]);

  // Foco preso por teclado. `aria-modal` já contém o cursor do VoiceOver, mas
  // não o Tab de um teclado externo — que sairia para a tela atrás, ainda
  // visível por trás do backdrop. Cicla dentro do painel nas duas pontas.
  const aoTabular = (e: EventoDeTecla<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !painel.current) return;
    const focaveis = Array.from(painel.current.querySelectorAll<HTMLElement>(FOCAVEIS));
    if (!focaveis.length) {
      e.preventDefault();
      return;
    }
    const primeiro = focaveis[0];
    const ultimo = focaveis[focaveis.length - 1];
    const atual = document.activeElement;
    // Vindo do painel (foco inicial), o Shift+Tab também tem de dar a volta.
    if (e.shiftKey && (atual === primeiro || atual === painel.current)) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && atual === ultimo) {
      e.preventDefault();
      primeiro.focus();
    }
  };

  // Fechado é fechado: nada montado. Um fragmento vazio em vez de `null` porque
  // a assinatura acordada com os três modais promete `JSX.Element` — quem
  // renderiza a moldura não precisa tratar o caso "não veio nada".
  if (!aberto) return <></>;

  return (
    <div className="ms-sheet">
      {/* Irmão do painel, nunca pai: por isso um toque no conteúdo não vira
          toque no backdrop. Soltar o dedo aqui depois de arrastar de dentro do
          painel também não fecha — o clique nasce no ancestral comum. */}
      <div className="ms-sheet__backdrop" onClick={onFechar} />
      <div
        className="ms-sheet__painel"
        ref={painel}
        role="dialog"
        aria-modal="true"
        aria-label={rotulo}
        tabIndex={-1}
        onKeyDown={aoTabular}
        style={{ '--ms-sheet-teclado': `${teclado}px` } as CSSProperties}
      >
        {/* A barrinha do handoff é o único controle da moldura. Como botão ela
            ganha um alvo de 44pt (CSS) e um nome para quem lê tela, em vez de
            ser enfeite que parece arrastável e não faz nada. */}
        <button type="button" className="ms-sheet__grabber" aria-label="Fechar" onClick={onFechar} />
        {titulo === undefined ? null : <div className="ms-sheet__cabecalho">{titulo}</div>}
        <div className="ms-sheet__corpo">{children}</div>
        {rodape === undefined ? null : <div className="ms-sheet__rodape">{rodape}</div>}
      </div>
    </div>
  );
}
