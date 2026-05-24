import { ArrowLeftIcon, CalendarIcon, CheckCircleIcon, CoffeeIcon, MoonIcon, PlayIcon, TargetIcon } from '../icons/Icons';

interface Routine {
  id: string;
  title: string;
  detail: string;
  icon: JSX.Element;
  prompt: string;
}

interface RoutinesViewProps {
  onBack: () => void;
  onRun: (prompt: string) => void;
}

const ROUTINES: Routine[] = [
  {
    id: 'morning',
    title: 'Comecar o dia',
    detail: 'Agenda, tarefas, saude, clima e uma ordem clara de prioridade.',
    icon: <CoffeeIcon size={20} />,
    prompt: 'Faz meu briefing da manha: agenda de hoje, tarefas importantes, pendencias, saude/sono se tiver dados, clima e as 3 prioridades do dia.',
  },
  {
    id: 'meeting',
    title: 'Preparar reuniao',
    detail: 'Busca proximos eventos e monta contexto, notas ligadas e perguntas.',
    icon: <CalendarIcon size={20} />,
    prompt: 'Prepara minha proxima reuniao: olha agenda, notas e open loops relacionados. Me da contexto, riscos, perguntas e proximas acoes.',
  },
  {
    id: 'focus',
    title: 'Foco profundo',
    detail: 'Escolhe uma tarefa, reduz ruido e sugere um bloco de trabalho.',
    icon: <TargetIcon size={20} />,
    prompt: 'Quero entrar em foco profundo. Escolhe a tarefa mais importante agora, define um bloco de foco, remove distracoes e me diz exatamente por onde comecar.',
  },
  {
    id: 'shutdown',
    title: 'Encerrar o dia',
    detail: 'Fecha loops, captura aprendizados e prepara amanha.',
    icon: <MoonIcon size={20} />,
    prompt: 'Vamos encerrar o dia: revisa o que ficou aberto, registra aprendizados importantes na memoria, sugere o que arquivar e prepara um plano simples para amanha.',
  },
  {
    id: 'weekly',
    title: 'Revisao semanal',
    detail: 'Resumo de tarefas, habitos, financas, saude, decisoes e open loops.',
    icon: <CheckCircleIcon size={20} />,
    prompt: 'Faz minha revisao semanal completa: tarefas criadas e concluidas, habitos, financas, saude, decisoes, open loops e sugestoes praticas para a proxima semana.',
  },
  {
    id: 'project-plan',
    title: 'Planejar projeto',
    detail: 'Transforma uma ideia em escopo, riscos, marcos e proximas acoes.',
    icon: <TargetIcon size={20} />,
    prompt: 'Vamos planejar um projeto de trabalho. Use list_work_projects; se nao existir o projeto certo, use create_work_project. Depois crie as primeiras tarefas com add_task e vincule ao projeto com link_work_project_item.',
  },
  {
    id: 'project-review',
    title: 'Revisar sprint',
    detail: 'Repassa projetos ativos, tarefas abertas, bloqueios e entregas.',
    icon: <CheckCircleIcon size={20} />,
    prompt: 'Faz uma revisao de sprint dos meus trabalhos. Use list_work_projects e o briefing/autopilot de trabalho se disponivel. Liste bloqueios, decisoes pendentes e crie ou atualize tarefas reais quando eu aprovar.',
  },
  {
    id: 'project-close',
    title: 'Fechar entrega',
    detail: 'Confere pendencias, evidencias, comunicacao e aprendizado.',
    icon: <MoonIcon size={20} />,
    prompt: 'Me ajuda a fechar uma entrega de trabalho. Encontre o projeto com list_work_projects, confira pendencias vinculadas, gere checklist final, registre uma nota de aprendizado se fizer sentido e proponha marcar o projeto como done.',
  },
  {
    id: 'project-meeting',
    title: 'Reuniao de projeto',
    detail: 'Prepara contexto, status, riscos e perguntas para alinhamento.',
    icon: <CalendarIcon size={20} />,
    prompt: 'Prepara uma reuniao de projeto. Use list_work_projects para identificar o contexto, traga status, tarefas abertas, decisoes, riscos, perguntas e proximas acoes; crie tarefas de follow-up se eu confirmar.',
  },
];

export function RoutinesView({ onBack, onRun }: RoutinesViewProps): JSX.Element {
  return (
    <div className="routines-view">
      <div className="routines-view__header">
        <button className="routines-view__back" type="button" onClick={onBack}>
          <ArrowLeftIcon size={18} />
          <span>Voltar</span>
        </button>
        <div>
          <h2 className="routines-view__title">Rotinas</h2>
          <p className="routines-view__subtitle">Fluxos prontos para momentos recorrentes.</p>
        </div>
      </div>

      <div className="routines-grid">
        {ROUTINES.map((routine) => (
          <button
            key={routine.id}
            type="button"
            className="routine-card"
            onClick={() => onRun(routine.prompt)}
          >
            <span className="routine-card__icon">{routine.icon}</span>
            <span className="routine-card__body">
              <strong>{routine.title}</strong>
              <span>{routine.detail}</span>
            </span>
            <span className="routine-card__run">
              <PlayIcon size={16} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
