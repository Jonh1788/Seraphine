import { useState } from 'react';
import { MobileSheet } from '../MobileSheet';
import { AlertTriangleIcon, SparkleIcon } from '../../icons/Icons';
import './ModalMemoria.css';

// MODAL DE LEMBRANÇA (handoff: frame "Modal · nova memória").
//
// Ao contrário do irmão de tarefa, aqui o salvar é EXPLÍCITO: um POST, um
// botão. O que os dois compartilham é a regra que importa — nada sai desta tela
// calado. O POST que falha não fecha o sheet, aparece como `role="alert"` no
// rodapé (que fica FORA da rolagem, por construção do `MobileSheet`) e devolve
// o texto intacto ao campo.
//
// Não é tela de registry de propósito: modal é sobreposição sobre a tela atual,
// não destino de navegação. O shell só repassa `id/onBack/onOpen/onDone`, então
// roteá-lo pela registry descartaria calado o `criar` — que é a única coisa que
// este arquivo não pode perder.
//
// ── O QUE `POST /memory/facts` ACEITA, VERIFICADO NA FONTE ───────────────────
// `backend/seraphine/memory/routes.py:63` declara
// `FactCreate = {text: str (min_length 1), source: str = "explicit",
// confidence: float (ge 0, le 1) = 1.0}` — e só. A rota chama
// `memory.learn_fact(text, source=…, confidence=…)`, que também não tem
// parâmetro de categoria.
//
// Daí as duas respostas OPOSTAS deste arquivo, pelo mesmo critério:
//  - CONFIANÇA: desenhada. A api aceita o campo, e o número escolhido é
//    exatamente o que a tela de Memória lê de volta para dizer alta/média/baixa.
//  - CATEGORIA: NÃO desenhada, apesar dos cinco chips do handoff. Quem escolhe
//    a categoria é `store.add_fact`, derivando-a do texto
//    (`_derive_fact_category`); um POST com categoria não a levaria a lugar
//    nenhum. Cinco chips que o servidor ignora seriam o mesmo botão morto que a
//    tela de Memória recusou quando o "+" não tinha POST. No lugar deles fica
//    uma linha dizendo quem escolhe — afirmação verificada, não consolo.
//
// ── POR QUE `criar` É OBRIGATÓRIO, E NÃO TEM PADRÃO ──────────────────────────
// `src/memory/api.ts` exporta HOJE `listFacts` e `fetchProfile` — leitura, só.
// Não há `createFact`, embora o backend tenha o POST. Esta task não pode editar
// `memory/api.ts` (arquivo de outro dono) e telas não fazem `fetch`. O irmão de
// tarefa pôde ter um padrão porque `updateTaskStatus` existe e salva de
// verdade; aqui um padrão só poderia lançar erro em toda chamada — um escritor
// morto, que é pior que escritor nenhum, pela mesma razão que derrubou o "+".
// Então o escritor é INJETADO e obrigatório: enquanto `memory/api.ts` não
// crescer `createFact`, o compilador não deixa ninguém montar este modal
// achando que ele grava. O relatório da task pede essa função.

/** O corpo de `POST /memory/facts`, campo a campo, sem nada a mais. */
export interface NovaLembranca {
  /** `FactCreate.text` — o backend exige `min_length=1`; quem exige que não
   *  seja só espaço é esta tela. */
  text: string;
  /** `FactCreate.source`. `explicit` é o que a tela de desktop já manda para a
   *  mesma ação (o usuário digitou o fato), e é o padrão do backend. */
  source: string;
  /** `FactCreate.confidence`, 0..1. */
  confidence: number;
}

export interface ModalMemoriaProps {
  aberto: boolean;
  onFechar: () => void;
  /** Persiste a lembrança nova. Obrigatório de propósito — ver o bloco acima. */
  criar: (nova: NovaLembranca) => Promise<void>;
  /** O POST voltou 201: quem abriu costuma querer relistar. */
  onCriada?: () => void;
}

/** Os três degraus do handoff e o número que cada um manda.
 *
 *  Os números não são enfeite: `MemoriaScreen.confianca()` classifica o que
 *  volta do backend em `>= .8` alta, `>= .5` média e o resto baixa. Se este
 *  mapa saísse dessas faixas, o cartão chamaria de "média" o que o usuário
 *  marcou como "alta" — divergência calada entre duas telas de donos
 *  diferentes, do mesmo tipo que a lista de backends flat já custou. O teste
 *  prende as faixas.
 *
 *  A COR de "baixa" DIVERGE do cartão de propósito: lá baixa é âmbar (o cartão
 *  usa duas tintas), aqui é vermelha, porque é o que o frame desenha e porque
 *  na hora de ESCOLHER convém que o degrau mais fraco pareça o mais fraco. */
export const CONFIANCAS: ReadonlyArray<{ valor: string; rotulo: string; numero: number; cor: string }> = [
  { valor: 'alta', rotulo: 'Alta', numero: 1, cor: '#4ade80' },
  { valor: 'media', rotulo: 'Média', numero: 0.6, cor: '#ffa726' },
  { valor: 'baixa', rotulo: 'Baixa', numero: 0.3, cor: '#ef6b6b' },
];

/** `#rrggbb` + alfa → `rgba(...)`, para o quadradinho do ícone seguir a cor do
 *  degrau escolhido, como o handoff pinta o de Alta em verde. */
function tinta(hex: string, alfa: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alfa})`;
}

type Estado = 'ocioso' | 'salvando' | 'erro' | 'descartar';

export function ModalMemoria({ aberto, onFechar, criar, onCriada }: ModalMemoriaProps): JSX.Element {
  const [texto, setTexto] = useState('');
  const [confianca, setConfianca] = useState(CONFIANCAS[0].valor);
  const [estado, setEstado] = useState<Estado>('ocioso');

  const limpo = texto.trim();
  const degrau = CONFIANCAS.find((c) => c.valor === confianca) ?? CONFIANCAS[0];

  /** UMA regra, lida pelo `disabled` do botão E pela guarda do envio. Duplicar
   *  a condição nos dois lugares é como as duas pontas divergem calado — foi
   *  isso que a lista de backends flat custou nesta mesma onda. Espaço em
   *  branco não passa: o backend só exige `min_length=1`, então " " viraria uma
   *  lembrança que não diz nada. */
  const podeSalvar = limpo !== '' && estado !== 'salvando';

  const enviar = async (): Promise<void> => {
    // Redundante com o `disabled` de propósito: `enviar` é chamado de dois
    // lugares, e um botão que deixe de nascer desabilitado não pode virar POST
    // em branco. Sendo a MESMA `podeSalvar` do botão, as duas pontas não têm
    // como discordar.
    if (!podeSalvar) return;
    setEstado('salvando');
    try {
      await criar({ text: limpo, source: 'explicit', confidence: degrau.numero });
      onCriada?.();
      onFechar();
    } catch {
      // Nem `setTexto('')` nem `onFechar()`: o texto é a única cópia do que o
      // usuário escreveu, e fechar aqui seria afirmar que a Seraphine guardou.
      setEstado('erro');
    }
  };

  /** Saída pelo backdrop, pelo grabber ou por Escape. Com texto escrito, o
   *  primeiro toque avisa e o segundo sai: um roçar no backdrop apagando uma
   *  lembrança inteira é o mesmo sumiço silencioso do save calado, e é o mais
   *  fácil de causar sem querer. Vazio não tem o que perder e sai de primeira.
   *  (O "Cancelar" do cabeçalho não passa por aqui — ele é o descarte pedido em
   *  voz alta, e pedir confirmação de quem já disse "cancelar" é ruído.) */
  const tentarSair = (): void => {
    if (!limpo || estado === 'descartar') {
      onFechar();
      return;
    }
    setEstado('descartar');
  };

  const cabecalho = (
    <div className="ms-mmemoria-cabecalho">
      <button type="button" className="ms-mmemoria-acao" onClick={onFechar}>
        Cancelar
      </button>
      <span className="ms-mmemoria-titulo">Nova lembrança</span>
      <button
        type="button"
        className="ms-mmemoria-acao ms-mmemoria-acao--salvar"
        onClick={() => void enviar()}
        disabled={!podeSalvar}
      >
        Salvar
      </button>
    </div>
  );

  const rodape = (
    <div className="ms-mmemoria-rodape">
      {estado === 'erro' || estado === 'descartar' ? (
        // A ÚNICA região com `role="alert"` do modal — o aviso de descarte
        // passa pelo mesmo lugar do erro, para não haver dois alertas
        // competindo pela atenção de quem lê tela.
        <span className={`ms-mmemoria-status ms-mmemoria-status--${estado === 'erro' ? 'erro' : 'aviso'}`} role="alert">
          <AlertTriangleIcon size={12} />
          {estado === 'erro' ? 'erro ao salvar' : 'toque de novo para descartar o que você escreveu'}
          {estado === 'erro' ? (
            <button type="button" className="ms-mmemoria-retentar" onClick={() => void enviar()}>
              tentar de novo
            </button>
          ) : null}
        </span>
      ) : (
        <span className="ms-mmemoria-status" role="status">
          {estado === 'salvando' ? 'salvando…' : ''}
        </span>
      )}
    </div>
  );

  return (
    <MobileSheet aberto={aberto} onFechar={tentarSair} rotulo="Nova lembrança" titulo={cabecalho} rodape={rodape}>
      <p className="ms-mmemoria-dica">
        <span className="ms-mmemoria-dica-icone" aria-hidden="true">
          <SparkleIcon size={15} />
        </span>
        Escreva como se fosse me contar. Vou usar isso nas próximas conversas.
      </p>

      <textarea
        className="ms-mmemoria-campo"
        aria-label="Lembrança"
        placeholder="Ex: prefiro reuniões depois das 10h…"
        value={texto}
        onChange={(e) => {
          setTexto(e.target.value);
          // O erro era do envio ANTERIOR: mantê-lo sobre um texto já corrigido
          // faria o usuário achar que a correção também falhou. O aviso de
          // descarte cai junto, porque ele deixou de estar saindo.
          setEstado((atual) => (atual === 'salvando' ? atual : 'ocioso'));
        }}
      />

      <p className="ms-mmemoria-eyebrow">CATEGORIA</p>
      {/* Sem chips: `POST /memory/facts` não tem campo de categoria. A frase
          descreve o que o servidor faz de fato, e não é controle nenhum. */}
      <p className="ms-mmemoria-nota">
        A Seraphine escolhe sozinha, pelo que você escrever — Pessoas, Rotina, Trabalho, Preferência ou Metas.
      </p>

      <div className="ms-mmemoria-linha">
        <span
          className="ms-mmemoria-icone"
          style={{ backgroundColor: tinta(degrau.cor, 0.13), color: degrau.cor }}
          aria-hidden="true"
        >
          <SparkleIcon size={16} />
        </span>
        <span className="ms-mmemoria-linha-txt">
          <span className="ms-mmemoria-rotulo">Confiança</span>
          <span className="ms-mmemoria-sub">o quanto devo levar isso a sério</span>
        </span>
        <span className="ms-mmemoria-valor" style={{ color: degrau.cor }} aria-hidden="true">
          <span className="ms-mmemoria-ponto" style={{ backgroundColor: degrau.cor }} />
          {degrau.rotulo}
        </span>
        {/* O select nativo cobre a linha: no iPhone o toque abre o seletor do
            sistema e o dedo ganha 44pt de alvo sem engordar o desenho.
            Invisível, não removido — continua focável e nomeado. */}
        <select
          className="ms-mmemoria-sobreposto"
          aria-label="Confiança"
          value={confianca}
          onChange={(e) => setConfianca(e.target.value)}
        >
          {CONFIANCAS.map((c) => (
            <option key={c.valor} value={c.valor}>{c.rotulo}</option>
          ))}
        </select>
      </div>
    </MobileSheet>
  );
}
