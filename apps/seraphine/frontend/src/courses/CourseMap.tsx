import { CheckIcon } from '../icons/Icons';
import type { Course } from './api';

export function CourseMap({ course, onOpenLesson }:
  { course: Course; onOpenLesson: (lessonId: string) => void }) {
  const doneCount = course.lessons.filter((l) => l.lock === 'done').length;
  return (
    <div className="trilha-map">
      <div className="trilha-map__head">
        <h2 className="trilha-map__title">{course.title || course.topic}</h2>
        <div className="trilha-progress">
          <div className="trilha-progress__bar"
            style={{ width: `${course.lessons.length ? (doneCount / course.lessons.length) * 100 : 0}%` }} />
        </div>
      </div>
      <ol className="trilha-nodes">
        {course.lessons.map((l) => (
          <li key={l.id} className={`trilha-node trilha-node--${l.lock}`}>
            <button type="button" className="trilha-node__btn"
              disabled={l.lock === 'locked'}
              onClick={() => onOpenLesson(l.id)}>
              <span className="trilha-node__idx">{l.order_idx + 1}</span>
              <span className="trilha-node__title">{l.title}</span>
              {l.lock === 'done' && <span className="trilha-node__check"><CheckIcon size={18} /></span>}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
