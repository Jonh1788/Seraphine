import { useEffect, useState, type ReactNode } from 'react';
import { listHabits, toggleHabit } from '../../habits/api';
import type { HabitWithStatus } from '../../habits/types';
import { addWaterIntake, getWaterToday } from '../../water/api';
import type { WaterToday } from '../../water/types';
import { habitIcon } from '../../habits/HabitIconMap';
import { ArrowLeftIcon, CheckIcon, DropletIcon, FlameIcon, PlusIcon, SparkleIcon } from '../../icons/Icons';
import type { ScreenProps } from './registry';
import './HabitosScreen.css';

// REGRA DA TELA (igual à do Hoje): nenhum bloco devolve `null`. Cabeçalho,
// lista, água e sugestão têm cada um as três saídas — dado, vazio desenhado e
// erro — e cada bloco erra com a SUA frase, para o teste apontar um bloco só.
//
// O handoff desenha ícones e sequência com emoji (livro, gota, chama); aqui eles
// viram SVG inline do `Icons.tsx`, que é regra do projeto. A cor de cada linha
// continua a do hábito, então o efeito visual (chip colorido) é o mesmo.

/** Um copo. É o incremento do "+" da água, igual ao do widget do desktop. */
const COPO_ML = 250;

export function HabitosScreen({ onBack }: ScreenProps) {
  const [habits, setHabits] = useState<HabitWithStatus[] | null>(null);
  const [erro, setErro] = useState(false);
  const [loading, setLoading] = useState(true);
  const [erroSalvar, setErroSalvar] = useState(false);

  useEffect(() => {
    let vivo = true;
    listHabits()
      .then((h) => { if (vivo) { setHabits(h); setErro(false); setLoading(false); } })
      .catch(() => { if (vivo) { setHabits(null); setErro(true); setLoading(false); } });
    return () => { vivo = false; };
  }, []);

  // O dia é o recorte da tela: hábito que não cai hoje não entra na conta nem
  // na lista — mas a lista vazia por causa DESSE filtro tem frase própria, que
  // foi o bug do Hoje (filtro do domínio zerava a lista e o bloco sumia).
  const doDia = (habits ?? []).filter((h) => h.is_target_today);
  const feitos = doDia.filter((h) => h.today_completed).length;
  const pendentes = doDia.filter((h) => !h.today_completed);
  const proximo = pendentes[0] ?? null;
  const maiorStreak = (habits ?? []).reduce((m, h) => Math.max(m, h.current_streak), 0);

  const alternar = async (h: HabitWithStatus) => {
    setErroSalvar(false);
    const patch = (mud: Partial<HabitWithStatus>) =>
      setHabits((atual) => (atual ?? []).map((x) => (x.id === h.id ? { ...x, ...mud } : x)));
    patch({ today_completed: !h.today_completed }); // otimista: o toque responde na hora
    try {
      const res = await toggleHabit(h.id);
      patch({
        today_completed: res.log.completed,
        current_streak: res.current_streak,
        best_streak: res.best_streak,
        total_completed: res.total_completed,
      });
    } catch {
      patch({ today_completed: h.today_completed }); // desfaz: o servidor não recebeu
      setErroSalvar(true);
    }
  };

  return (
    <div className="ms-habitos">
      <header className="ms-habitos-head">
        {/* O shell não desenha mais chrome nenhum: a seta de voltar é da tela.
            É o mesmo arrow-left das telas empurradas do handoff (18px, --dim).
            `onBack` é opcional no ScreenProps — sem ele não há para onde voltar,
            então o controle não aparece em vez de virar um botão morto. */}
        {onBack && (
          <button type="button" className="ms-habitos-voltar" aria-label="Voltar" onClick={onBack}>
            <ArrowLeftIcon size={18} />
          </button>
        )}
        <div className="ms-habitos-head-txt">
          <h1 className="ms-habitos-titulo">Hábitos</h1>
          {loading ? <Skel linhas={1} />
            : erro ? <Erro>Não consegui carregar o resumo de hoje.</Erro>
            : doDia.length ? <p className="ms-habitos-sub">{feitos} de {doDia.length} concluídos hoje</p>
            : <Vazio>nada marcado para hoje</Vazio>}
        </div>
        <span className="ms-habitos-streak">
          <FlameIcon size={13} />
          {loading ? <span className="ms-habitos-streak-skel" aria-hidden="true" />
            : erro ? <span className="ms-habitos-streak-txt">—</span>
            : <span className="ms-habitos-streak-txt">{maiorStreak} {maiorStreak === 1 ? 'dia' : 'dias'}</span>}
        </span>
      </header>

      <div className="ms-habitos-lista">
        {loading ? <SkelLinhas />
          : erro ? <div className="ms-habitos-caixa"><Erro>Não consegui carregar seus hábitos.</Erro></div>
          : doDia.length ? doDia.map((h) => (
            <Linha
              key={h.id}
              habit={h}
              destacado={proximo?.id === h.id}
              unicoPendente={pendentes.length === 1 && proximo?.id === h.id}
              onToggle={() => alternar(h)}
            />
          ))
          : (habits ?? []).length ? <div className="ms-habitos-caixa"><Vazio>Nenhum hábito programado para hoje — os seus caem em outros dias.</Vazio></div>
          : <div className="ms-habitos-caixa"><Vazio>Você ainda não registrou nenhum hábito — crie o primeiro para começar a contar sequência.</Vazio></div>}

        {erroSalvar && <Erro>Não consegui salvar essa marcação.</Erro>}

        {/* A água é um bloco à parte (api própria, meta própria). Fica no fim da
            lista para os hábitos do usuário ficarem contíguos; no handoff ela
            aparece intercalada, o que é arranjo do mock, não regra. */}
        <Agua />
      </div>

      <section className="ms-habitos-sugere">
        <span className="ms-habitos-sugere-icone"><SparkleIcon size={15} /></span>
        {loading ? <Skel linhas={1} />
          : erro ? <Erro>Não consegui pensar em uma sugestão agora.</Erro>
          : !doDia.length ? <Vazio>Crie um hábito e eu começo a sugerir ajustes por aqui.</Vazio>
          : <span className="ms-habitos-sugere-txt">{sugestao(pendentes, maiorStreak)}</span>}
      </section>
    </div>
  );
}

/** Sugestão derivada do próprio dado — sem chamada extra, sem inventar fato. */
function sugestao(pendentes: HabitWithStatus[], maiorStreak: number): string {
  if (pendentes.length === 0) {
    return maiorStreak > 0
      ? `Tudo concluído hoje — sua sequência de ${maiorStreak} ${maiorStreak === 1 ? 'dia' : 'dias'} segue de pé.`
      : 'Tudo concluído hoje. Amanhã eu te lembro de novo.';
  }
  if (pendentes.length === 1) return `Falta só ${pendentes[0].title} hoje — quer um lembrete às 21h?`;
  return `Faltam ${pendentes.length} hábitos hoje — que tal começar por ${pendentes[0].title}?`;
}

function Linha({ habit, destacado, unicoPendente, onToggle }: {
  habit: HabitWithStatus;
  destacado: boolean;
  unicoPendente: boolean;
  onToggle: () => void;
}) {
  const feito = habit.today_completed;
  const cor = /^#[0-9a-f]{6}$/i.test(habit.color) ? habit.color : null;
  return (
    <div className={`ms-habitos-linha${destacado ? ' ms-habitos-linha--pendente' : ''}`}>
      <span
        className="ms-habitos-icone"
        style={cor ? { background: `${cor}1f`, color: cor } : undefined}
      >
        {habitIcon(habit.icon, 17)}
      </span>
      <div className="ms-habitos-corpo">
        <p className="ms-habitos-nome">{habit.title}</p>
        {habit.current_streak > 0 ? (
          <p className="ms-habitos-meta ms-habitos-meta--streak">
            <FlameIcon size={11} />
            <span>{habit.current_streak} {habit.current_streak === 1 ? 'dia' : 'dias'}</span>
          </p>
        ) : (
          <p className="ms-habitos-meta">
            {unicoPendente ? 'falta só esse hoje' : feito ? 'concluído hoje' : 'sem sequência ainda'}
          </p>
        )}
      </div>
      <button
        type="button"
        className={`ms-habitos-check${feito ? ' ms-habitos-check--on' : ''}`}
        aria-pressed={feito}
        aria-label={`${feito ? 'Desmarcar' : 'Concluir'} ${habit.title}`}
        onClick={onToggle}
      >
        {feito ? <CheckIcon size={16} /> : null}
      </button>
    </div>
  );
}

/** Água: progresso do dia e o "+" que registra um copo. Api própria, erro
 *  próprio — uma falha aqui não pode derrubar a lista de hábitos. */
function Agua() {
  const [hoje, setHoje] = useState<WaterToday | null>(null);
  const [erro, setErro] = useState(false);
  const [loading, setLoading] = useState(true);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    let vivo = true;
    getWaterToday()
      .then((d) => { if (vivo) { setHoje(d); setErro(false); setLoading(false); } })
      .catch(() => { if (vivo) { setHoje(null); setErro(true); setLoading(false); } });
    return () => { vivo = false; };
  }, []);

  const registrar = async () => {
    setSalvando(true);
    try {
      const res = await addWaterIntake(COPO_ML);
      setHoje((prev) => ({
        total: res.total_today,
        goal: res.goal,
        percent: res.percent,
        logs: prev?.logs ?? [],
      }));
      setErro(false);
    } catch {
      setErro(true);
    } finally {
      setSalvando(false);
    }
  };

  const meta = hoje?.goal ?? 0;
  const total = hoje?.total ?? 0;
  const pct = meta > 0 ? Math.max(0, Math.min(100, Math.round((total / meta) * 100))) : 0;

  return (
    <div className="ms-habitos-linha ms-habitos-agua">
      <span className="ms-habitos-icone ms-habitos-icone--agua"><DropletIcon size={17} /></span>
      <div className="ms-habitos-corpo">
        <p className="ms-habitos-nome">{meta > 0 ? `Beber ${litros(meta)}L de água` : 'Beber água'}</p>
        {loading ? <Skel linhas={1} />
          : erro ? <Erro>Não consegui carregar a água de hoje.</Erro>
          : meta > 0 ? (
            <div className="ms-habitos-agua-prog">
              <div className="ms-habitos-agua-barra">
                <span style={{ width: `${pct}%` }} />
              </div>
              <span className="ms-habitos-agua-label">{litros(total)} / {litros(meta)}L</span>
            </div>
          )
          : <Vazio>Você ainda não definiu uma meta de água.</Vazio>}
      </div>
      <button
        type="button"
        className="ms-habitos-add"
        aria-label={`Registrar ${COPO_ML} ml de água`}
        onClick={registrar}
        disabled={salvando}
      >
        <PlusIcon size={14} />
      </button>
    </div>
  );
}

/** ml → litros em pt-BR, sem depender de ICU: 1500 → "1,5"; 2000 → "2". */
function litros(ml: number): string {
  return String(Math.round(ml / 10) / 100).replace('.', ',');
}

/** Linha de "não há nada": o bloco continua de pé e diz o porquê. */
function Vazio({ children }: { children: ReactNode }) {
  return <p className="ms-habitos-vazio">{children}</p>;
}

/** Linha de falha. Tinta de perigo para nunca ser confundida com vazio. */
function Erro({ children }: { children: ReactNode }) {
  return <p className="ms-habitos-erro" role="alert">{children}</p>;
}

/** Espera sem texto: nada pode piscar "tudo em dia" antes do dado chegar. */
function Skel({ linhas = 2 }: { linhas?: number }) {
  return (
    <div className="ms-habitos-skel" aria-hidden="true">
      {Array.from({ length: linhas }, (_, i) => <span key={i} />)}
    </div>
  );
}

function SkelLinhas() {
  return (
    <div className="ms-habitos-skel-lista" aria-hidden="true">
      {Array.from({ length: 4 }, (_, i) => <span key={i} className="ms-habitos-skel-linha" />)}
    </div>
  );
}
