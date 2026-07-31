import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createJournalEntry, fetchJournalEntries, fetchJournalStats } from '../../journal/api';
import type { JournalEntry, JournalStats } from '../../journal/types';
import { fetchMoodTrend } from '../../mood/api';
import type { MoodTrendDay } from '../../mood/types';
import { MOODS, MoodFace, moodFromValence, type MoodKey } from '../../journal/moods';
import { ArrowLeftIcon, FlameIcon, SparkleIcon } from '../../icons/Icons';
import type { ScreenProps } from './registry';
import './DiarioScreen.css';

// REGRA DA TELA (igual à do Hoje e à do Hábitos): nenhum bloco devolve `null`.
// Sequência, mapa de humor e última entrada têm cada um as três saídas — dado,
// vazio desenhado e erro — e cada bloco erra com a SUA frase, para o teste
// apontar um bloco só. Quem abre o Diário pela primeira vez não tem entrada
// nenhuma nem histórico de humor: esse é o caso comum, não a exceção.
//
// O handoff desenha as caras do humor com emoji (😞 😐 🙂 😄 🤩) e a chama da
// sequência também. Emoji é proibido no projeto, então reaproveitamos o
// `journal/moods.tsx` do desktop, que já resolveu isso com SVG inline (5 caras
// estriadas, mesma paleta de valência do mock: #ef6b6b → #4ade80), e a chama
// vem do `Icons.tsx`. Ver o relatório da task: `moods.tsx` NÃO é emoji.

/** Chips do handoff: tocam o campo em vez de só decorar — semeiam o texto,
 *  como o compositor do desktop faz. */
const CHIPS: { rotulo: string; semente: string }[] = [
  { rotulo: 'Gratidão', semente: 'Hoje sou grato por ' },
  { rotulo: 'Desafios', semente: 'O maior desafio de hoje foi ' },
];

const MESES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

export function DiarioScreen({ onBack }: ScreenProps) {
  const agora = new Date();
  const diaHoje = agora.getDate();
  const prefixoMes = `${agora.getFullYear()}-${dois(agora.getMonth() + 1)}`;

  const [entradas, setEntradas] = useState<JournalEntry[] | null>(null);
  const [erroEntradas, setErroEntradas] = useState(false);
  const [carregandoEntradas, setCarregandoEntradas] = useState(true);

  const [tendencia, setTendencia] = useState<MoodTrendDay[] | null>(null);
  const [erroTendencia, setErroTendencia] = useState(false);
  const [carregandoTendencia, setCarregandoTendencia] = useState(true);

  const [stats, setStats] = useState<JournalStats | null>(null);
  const [erroStats, setErroStats] = useState(false);
  const [carregandoStats, setCarregandoStats] = useState(true);

  const [humor, setHumor] = useState<MoodKey | null>(null);
  const [texto, setTexto] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erroSalvar, setErroSalvar] = useState(false);

  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => { vivo.current = false; };
  }, []);

  // Cada fonte carrega e erra por conta própria: uma falha no /mood/trend não
  // pode levar junto a última entrada, que vem de outra rota.
  const carregar = useCallback(() => {
    fetchJournalEntries({ limit: 30 })
      .then((r) => { if (vivo.current) { setEntradas(r.entries); setErroEntradas(false); } })
      .catch(() => { if (vivo.current) { setEntradas(null); setErroEntradas(true); } })
      .finally(() => { if (vivo.current) setCarregandoEntradas(false); });

    // /mood/trend?days=N devolve os últimos N dias terminando hoje; pedir
    // `diaHoje` cobre exatamente do dia 1 do mês até hoje, que é a grade.
    fetchMoodTrend(diaHoje)
      .then((t) => { if (vivo.current) { setTendencia(t.days ?? []); setErroTendencia(false); } })
      .catch(() => { if (vivo.current) { setTendencia(null); setErroTendencia(true); } })
      .finally(() => { if (vivo.current) setCarregandoTendencia(false); });

    fetchJournalStats()
      .then((s) => { if (vivo.current) { setStats(s); setErroStats(false); } })
      .catch(() => { if (vivo.current) { setStats(null); setErroStats(true); } })
      .finally(() => { if (vivo.current) setCarregandoStats(false); });
  }, [diaHoje]);

  useEffect(() => { carregar(); }, [carregar]);

  // Mapa dia → valência. O /mood/trend é a fonte (todo check-in, conversa e
  // voz entram nele); quando ele não tem nada do mês, caímos no humor gravado
  // nas próprias entradas — o POST /journal guarda mood_label/mood_valence na
  // entrada e NÃO escreve mood_log, então sem esse fallback o humor escolhido
  // aqui nunca apareceria no mapa.
  const porDia = new Map<number, number>();
  for (const d of tendencia ?? []) {
    if (!d.date?.startsWith(prefixoMes)) continue;
    const dia = Number(d.date.slice(8, 10));
    if (Number.isFinite(dia)) porDia.set(dia, d.avg_valence);
  }
  if (porDia.size === 0) {
    for (const e of entradas ?? []) {
      const data = (e.date ?? '').slice(0, 10);
      if (!data.startsWith(prefixoMes) || e.mood_valence == null) continue;
      const dia = Number(data.slice(8, 10));
      // entradas vêm em ordem decrescente: a primeira de cada dia é a mais nova
      if (Number.isFinite(dia) && !porDia.has(dia)) porDia.set(dia, e.mood_valence);
    }
  }

  const ultimaValencia = [...porDia.entries()].sort((a, b) => b[0] - a[0])[0]?.[1];
  const humorAtual = ultimaValencia == null ? null : moodFromValence(ultimaValencia);
  const ultima = (entradas ?? [])[0] ?? null;
  const streak = stats?.current_streak ?? 0;

  const chip = (semente: string) => {
    setTexto((prev) => {
      const base = prev.trimEnd();
      return base.length > 0 ? `${base}\n${semente}` : semente;
    });
  };

  const salvar = async () => {
    const corpo = texto.trim();
    if (!corpo || salvando) return;
    setSalvando(true);
    setErroSalvar(false);
    // primeira linha vira título, como no compositor do desktop
    const primeira = corpo.split('\n')[0]?.trim() ?? '';
    const spec = humor ? MOODS.find((m) => m.key === humor) : undefined;
    try {
      await createJournalEntry({
        title: primeira ? primeira.slice(0, 80) : 'Entrada de hoje',
        content: corpo,
        tags: humor ? [humor] : [],
        mood_label: spec ? spec.key : null,
        mood_valence: spec ? spec.valence : null,
      });
      // só limpa depois do servidor aceitar: texto perdido é pior que repetido
      setTexto('');
      setHumor(null);
      carregar();
    } catch {
      setErroSalvar(true);
    } finally {
      if (vivo.current) setSalvando(false);
    }
  };

  return (
    <div className="ms-diario">
      <header className="ms-diario-head">
        {/* O shell não desenha mais chrome nenhum: a seta de voltar é da tela.
            `onBack` é opcional no ScreenProps — sem ele não há para onde voltar,
            então o controle não aparece em vez de virar um botão morto. */}
        {onBack && (
          <button type="button" className="ms-diario-voltar" aria-label="Voltar" onClick={onBack}>
            <ArrowLeftIcon size={18} />
          </button>
        )}
        <div className="ms-diario-head-txt">
          <h1 className="ms-diario-titulo">Diário</h1>
          {carregandoStats ? <Skel linhas={1} />
            : erroStats ? <Erro>Não consegui carregar sua sequência.</Erro>
            : streak > 0 ? <p className="ms-diario-sub">{streak} {streak === 1 ? 'dia seguido' : 'dias seguidos'} escrevendo</p>
            : <Vazio>você ainda não tem sequência — a de hoje começa aqui</Vazio>}
        </div>
        <span className="ms-diario-streak">
          <FlameIcon size={13} />
          {carregandoStats ? <span className="ms-diario-streak-skel" aria-hidden="true" />
            : <span className="ms-diario-streak-txt">{erroStats ? '—' : streak}</span>}
        </span>
      </header>

      <div className="ms-diario-corpo">
        {/* ── compositor: humor + texto + chips + Salvar ── */}
        <section className="ms-diario-card ms-diario-compositor">
          <div className="ms-diario-compositor-head">
            <span className="ms-diario-pergunta">Como foi seu dia?</span>
            <span className="ms-diario-selo">
              <SparkleIcon size={11} />
              Seraphine pergunta
            </span>
          </div>

          <div className="ms-diario-humores">
            {MOODS.map((m) => {
              const escolhido = humor === m.key;
              return (
                <button
                  key={m.key}
                  type="button"
                  className={`ms-diario-humor${escolhido ? ' ms-diario-humor--sel' : ''}`}
                  style={escolhido ? { color: m.color } : undefined}
                  aria-label={m.label}
                  aria-pressed={escolhido}
                  onClick={() => setHumor((atual) => (atual === m.key ? null : m.key))}
                >
                  <MoodFace mood={m.key} size={24} />
                </button>
              );
            })}
          </div>

          <textarea
            className="ms-diario-campo"
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            placeholder="O que te deu energia hoje?"
            rows={2}
            disabled={salvando}
          />

          <div className="ms-diario-pe">
            {CHIPS.map((c) => (
              <button
                key={c.rotulo}
                type="button"
                className="ms-diario-chip"
                onClick={() => chip(c.semente)}
              >
                {c.rotulo}
              </button>
            ))}
            <button
              type="button"
              className="ms-diario-salvar"
              onClick={() => void salvar()}
              disabled={salvando || !texto.trim()}
            >
              {salvando ? 'Salvando' : 'Salvar'}
            </button>
          </div>

          {erroSalvar && <Erro>Não consegui salvar sua entrada — o texto continua aqui.</Erro>}
        </section>

        {/* ── mapa de humor: um quadrado por dia do mês até hoje ── */}
        <section className="ms-diario-card ms-diario-mapa">
          <div className="ms-diario-mapa-head">
            <span className="ms-diario-mapa-titulo">Humor em {MESES[agora.getMonth()]}</span>
            {humorAtual && (
              <span className="ms-diario-mapa-cara" style={{ color: humorAtual.color }}>
                <MoodFace mood={humorAtual.key} size={16} />
              </span>
            )}
          </div>
          {carregandoTendencia ? <SkelMapa />
            : (
              <>
                <div className="ms-diario-mapa-grade">
                  {Array.from({ length: diaHoje }, (_, i) => {
                    const dia = i + 1;
                    const v = porDia.get(dia);
                    const spec = v == null ? null : moodFromValence(v);
                    const ehHoje = dia === diaHoje;
                    return (
                      <span
                        key={dia}
                        className={`ms-diario-mapa-cel${spec ? ' ms-diario-mapa-cel--com' : ''}${ehHoje ? ' ms-diario-mapa-cel--hoje' : ''}`}
                        style={spec && !ehHoje ? { background: spec.color } : undefined}
                        title={spec ? `Dia ${dia} · ${spec.label}` : `Dia ${dia} · sem humor registrado`}
                      />
                    );
                  })}
                </div>
                {/* A grade continua de pé nos três casos; o que muda é a linha
                    embaixo dela. O erro ganha precedência sobre o vazio: com a
                    tendência fora do ar o mapa pode estar completo pelo
                    fallback das entradas, e calar isso seria vender um mês
                    inteiro de humor que ninguém conferiu. */}
                {erroTendencia ? <Erro>Não consegui carregar seu mapa de humor.</Erro>
                  : porDia.size === 0 ? <Vazio>você ainda não registrou humor neste mês — escolha uma carinha acima</Vazio>
                  : null}
              </>
            )}
        </section>

        {/* ── última entrada ── */}
        <section className="ms-diario-card ms-diario-ultima">
          {carregandoEntradas ? <Skel linhas={2} />
            : erroEntradas ? <Erro>Não consegui carregar sua última entrada.</Erro>
            : ultima ? (
              <>
                <div className="ms-diario-ultima-head">
                  {/* Sem humor gravado não desenhamos cara nenhuma: o
                      `moodFromValence(null)` devolve o neutro, e pintá-lo aqui
                      inventaria um humor que o usuário nunca registrou. */}
                  {ultima.mood_valence != null && (
                    <span className="ms-diario-ultima-cara" style={{ color: moodFromValence(ultima.mood_valence).color }}>
                      <MoodFace mood={moodFromValence(ultima.mood_valence).key} size={16} />
                    </span>
                  )}
                  <span className="ms-diario-ultima-titulo">{rotuloDia(ultima.date, agora)} · {ultima.title}</span>
                  <span className="ms-diario-ultima-hora">{hora(ultima.created_at)}</span>
                </div>
                <p className="ms-diario-ultima-txt">{ultima.content}</p>
              </>
            )
            : <Vazio>você ainda não escreveu nada no diário — a primeira entrada pode ser essa aí de cima</Vazio>}
        </section>
      </div>
    </div>
  );
}

function dois(n: number): string {
  return String(n).padStart(2, '0');
}

/** Data local (não UTC) em YYYY-MM-DD: comparar com `toISOString()` erraria o
 *  dia à noite no fuso de São Paulo. */
function diaLocal(d: Date): string {
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
}

/** "Hoje" / "Ontem" / "12 de junho" a partir do campo `date` da entrada. */
function rotuloDia(iso: string, agora: Date): string {
  const data = (iso ?? '').slice(0, 10);
  if (!data) return '';
  if (data === diaLocal(agora)) return 'Hoje';
  const ontem = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() - 1);
  if (data === diaLocal(ontem)) return 'Ontem';
  const [ano, mes, dia] = data.split('-').map(Number);
  if (!ano || !mes || !dia) return data;
  return `${dia} de ${MESES[mes - 1] ?? ''}`.trim();
}

/** HH:MM local do `created_at`; string vazia quando a data não parseia. */
function hora(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${dois(d.getHours())}:${dois(d.getMinutes())}`;
}

/** Linha de "não há nada": o bloco continua de pé e diz o porquê. */
function Vazio({ children }: { children: ReactNode }) {
  return <p className="ms-diario-vazio">{children}</p>;
}

/** Linha de falha. Tinta de perigo para nunca ser confundida com vazio. */
function Erro({ children }: { children: ReactNode }) {
  return <p className="ms-diario-erro" role="alert">{children}</p>;
}

/** Espera sem texto: nada pode piscar "sem humor" antes do dado chegar. */
function Skel({ linhas = 2 }: { linhas?: number }) {
  return (
    <div className="ms-diario-skel" aria-hidden="true">
      {Array.from({ length: linhas }, (_, i) => <span key={i} />)}
    </div>
  );
}

/** Esqueleto da grade: os mesmos quadrados, sem cor e sem texto. */
function SkelMapa() {
  return (
    <div className="ms-diario-skel-grade" aria-hidden="true">
      {Array.from({ length: 20 }, (_, i) => <span key={i} />)}
    </div>
  );
}
