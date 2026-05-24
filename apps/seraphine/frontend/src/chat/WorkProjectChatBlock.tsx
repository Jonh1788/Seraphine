export interface WorkProjectBlockData {
  id: string;
  name: string;
  description?: string;
  area?: string;
  status?: string;
  priority?: string;
  due_date?: string | null;
}

interface WorkProjectChatBlockProps {
  project: WorkProjectBlockData;
  onOpen?: (id: string) => void;
}

export function WorkProjectChatBlock({ project, onOpen }: WorkProjectChatBlockProps): JSX.Element {
  return (
    <div className="work-chat-block">
      <div className="work-chat-block__header">
        <div>
          <strong>{project.name}</strong>
          <span>{project.area || 'Trabalho'} · {project.status || 'active'}</span>
        </div>
        <span className={`work-chat-block__priority work-chat-block__priority--${project.priority || 'medium'}`}>
          {project.priority || 'medium'}
        </span>
      </div>
      {project.description && <p>{project.description}</p>}
      <div className="work-chat-block__footer">
        <span>{project.due_date ? `Prazo ${project.due_date}` : 'Sem prazo'}</span>
        {onOpen && (
          <button type="button" onClick={() => onOpen(project.id)}>
            Abrir
          </button>
        )}
      </div>
    </div>
  );
}
