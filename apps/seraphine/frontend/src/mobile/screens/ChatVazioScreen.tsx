import { useState, type ComponentType, type FormEvent } from 'react';
import { Orb } from '../Orb';
import { BrainIcon, CalendarIcon, FinanceIcon, MicIcon, TargetIcon } from '../../icons/Icons';
import type { ScreenProps } from './registry';
import './ChatVazioScreen.css';

/**
 * Estado vazio do chat — primeiro uso. Handoff `Seraphine Mobile.dc.html`,
 * linha 647 (`<!-- ==== ESTADO VAZIO ==== -->`). É o único estado vazio que o
 * handoff de fato desenha, então aqui a fidelidade se confere contra o mock.
 *
 * ─── CONTRATO PARA A TASK 28 (integração com o ChatScreen) ───────────────────
 * Esta tela é autônoma: não busca nada, não conhece o WebSocket e não decide
 * quando aparecer. Quem integra escolhe uma das duas portas:
 *
 *   1. `<ChatVazioScreen onPrimeiraMensagem={(texto) => …} />`
 *      A tela inteira do handoff — cabeçalho (orb 38 + "Seraphine" + "pronta"),
 *      miolo e composer. Serve para ser renderizada NO LUGAR do ChatScreen
 *      enquanto não há histórico. `onPrimeiraMensagem` recebe o texto da
 *      sugestão tocada OU o que foi digitado no composer; é o texto cru, para
 *      quem integra mandar como primeira mensagem.
 *
 *   2. `<ChatVazioMiolo onSugestao={(texto) => …} />`
 *      Só orb 88 + título + as quatro sugestões, sem cabeçalho e sem composer.
 *      Serve para cair DENTRO da conversa do ChatScreen, que já tem os seus —
 *      assim a integração não duplica cabeçalho nem campo de texto.
 *
 * `onPrimeiraMensagem` é opcional porque o `registry` tipa toda tela como
 * `ComponentType<ScreenProps>`; sem ele a tela ainda desenha e os toques viram
 * no-op (nunca `null`, nunca exceção). O `registry` NÃO foi tocado.
 */

export interface ChatVazioProps extends ScreenProps {
  /** Texto da primeira mensagem: sugestão tocada ou digitada no composer. */
  onPrimeiraMensagem?: (texto: string) => void;
}

export interface Sugestao {
  texto: string;
  Icone: ComponentType<{ size?: number }>;
}

/** As quatro do handoff (linhas 660-663), na ordem. O mock usa emoji nos
 *  marcadores; a casa não usa emoji, então cada um virou o ícone SVG
 *  equivalente do `icons/Icons.tsx`. */
export const SUGESTOES: Sugestao[] = [
  { texto: 'Organiza minha semana', Icone: CalendarIcon },
  { texto: 'Me ajuda a controlar gastos', Icone: FinanceIcon },
  { texto: 'Quero criar um hábito novo', Icone: TargetIcon },
  { texto: 'Me ensina algo novo', Icone: BrainIcon },
];

export function ChatVazioScreen({ onPrimeiraMensagem, onOpen }: ChatVazioProps) {
  const [rascunho, setRascunho] = useState('');

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    const texto = rascunho.trim();
    // Mensagem em branco não abre conversa: sem isto, um Enter distraído
    // mandaria uma string vazia como primeira fala do usuário.
    if (!texto) return;
    setRascunho('');
    onPrimeiraMensagem?.(texto);
  };

  return (
    <div className="ms-chatvazio">
      <header className="ms-chatvazio__head">
        <Orb size={38} />
        <div className="ms-chatvazio__quem">
          <p className="ms-chatvazio__nome">Seraphine</p>
          <p className="ms-chatvazio__presenca">
            <span className="ms-chatvazio__ponto" aria-hidden="true" />
            pronta
          </p>
        </div>
      </header>

      <ChatVazioMiolo onSugestao={(texto) => onPrimeiraMensagem?.(texto)} />

      <form className="ms-chatvazio__composer" onSubmit={enviar}>
        <div className="ms-chatvazio__pill">
          <input
            className="ms-chatvazio__campo"
            placeholder="Mensagem…"
            value={rascunho}
            onChange={(e) => setRascunho(e.target.value)}
            enterKeyHint="send"
            autoComplete="off"
          />
          {/* No handoff o botão do composer vazio é o microfone, não o avião:
              antes da primeira palavra o caminho oferecido é falar. */}
          <button
            type="button"
            className="ms-chatvazio__mic"
            aria-label="Falar por voz"
            onClick={() => onOpen?.({ key: 'voz', title: 'Voz' })}
          >
            <MicIcon size={18} />
          </button>
        </div>
      </form>
    </div>
  );
}

/** Miolo centrado: orb de 88px, título e as quatro sugestões. Exportado à parte
 *  para a Task 28 poder embuti-lo na conversa do ChatScreen sem arrastar junto
 *  um segundo cabeçalho e um segundo composer. */
export function ChatVazioMiolo({ onSugestao }: { onSugestao?: (texto: string) => void }) {
  return (
    <div className="ms-chatvazio__miolo">
      <Orb size={88} float />
      <div className="ms-chatvazio__fala">
        {/* O <br> é do handoff (a quebra depois de "gente"); o espaço explícito
            mantém a frase inteira legível para leitor de tela e para o teste. */}
        <h1 className="ms-chatvazio__titulo">
          Sobre o que a gente<br aria-hidden="true" />{' '}conversa primeiro?
        </h1>
        <p className="ms-chatvazio__apoio">
          Toque numa sugestão ou só diga &ldquo;oi Sera&rdquo;.
        </p>
      </div>
      <div className="ms-chatvazio__sugestoes">
        {SUGESTOES.map(({ texto, Icone }) => (
          <button
            key={texto}
            type="button"
            className="ms-chatvazio__sugestao"
            onClick={() => onSugestao?.(texto)}
          >
            <span className="ms-chatvazio__sugestao-icone" aria-hidden="true"><Icone size={15} /></span>
            {texto}
          </button>
        ))}
      </div>
    </div>
  );
}
