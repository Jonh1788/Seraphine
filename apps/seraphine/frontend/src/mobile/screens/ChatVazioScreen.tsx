import { type ComponentType } from 'react';
import { Orb } from '../Orb';
import { BrainIcon, CalendarIcon, FinanceIcon, TargetIcon } from '../../icons/Icons';
import './ChatVazioScreen.css';

/**
 * Estado vazio do chat — primeiro uso. Handoff `Seraphine Mobile.dc.html`,
 * linha 647 (`<!-- ==== ESTADO VAZIO ==== -->`). É o único estado vazio que o
 * handoff de fato desenha, então aqui a fidelidade se confere contra o mock.
 *
 * ─── DECISÃO DA INTEGRAÇÃO (Task 28) ────────────────────────────────────────
 * A Task 23 entregou duas portas — a tela inteira (`ChatVazioScreen`, com
 * cabeçalho e composer próprios) e só o miolo — para a integração escolher uma.
 * Escolhido o MIOLO, embutido em `ChatScreen`, e a tela inteira foi removida
 * junto com a chave `chat-vazio` do registry (que navegação nenhuma alcançava).
 *
 * O motivo é honestidade, não economia: o cabeçalho daquela tela afirmava
 * "pronta" com uma bolinha verde piscando sem saber NADA da conexão — montado
 * no lugar do ChatScreen, diria "pronta" com o socket caído. O cabeçalho do
 * `ChatScreen` deriva a presença do `onStatus` do socket de verdade, e o
 * composer dele tem botão de enviar (o daqui só tinha o microfone, que navegava
 * para a Voz DESCARTANDO o rascunho). Embutir o miolo herda os dois honestos.
 *
 * Este arquivo, portanto, não exporta mais tela: exporta o bloco vazio do chat.
 * O nome foi mantido porque é o que os relatórios da onda citam.
 */

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

/** Miolo centrado: orb de 88px, título e as quatro sugestões — o vazio do chat
 *  sem cabeçalho e sem composer, para cair DENTRO da conversa do `ChatScreen`,
 *  que já tem os seus e os tem honestos. */
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
          {/* A frase é contrato com o classificador embarcado
              (`src-tauri/models/wakeword/ei_seraphine_v9.onnx`, limiar 0.92),
              treinado em "Ei Seraphine". O handoff dizia "oi Sera", que não
              aciona nada — e aqui a frase é instrução, não enfeite. */}
          Toque numa sugestão ou só diga &ldquo;Ei Seraphine&rdquo;.
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
