import { Skeleton } from '../utils';

/**
 * Placeholder for chat turns while history is being restored.
 * Renders a short pattern of alternating user/assistant bubbles to
 * echo the shape of the real thread (right-aligned short user lines,
 * left-aligned longer assistant blocks). The shimmer and layout are
 * driven entirely by CSS in `styles.css` (`.chat-skeleton*`).
 */
interface BubbleSpec {
  role: 'user' | 'assistant';
  lines: string[]; // widths of the skeleton text lines inside the bubble
  bubbleWidth: string;
}

const BUBBLES: BubbleSpec[] = [
  { role: 'user',      lines: ['90%'],          bubbleWidth: '40%' },
  { role: 'assistant', lines: ['100%', '80%'],  bubbleWidth: '65%' },
  { role: 'user',      lines: ['80%'],          bubbleWidth: '50%' },
  { role: 'assistant', lines: ['100%', '90%', '60%'], bubbleWidth: '70%' },
  { role: 'user',      lines: ['70%'],          bubbleWidth: '35%' },
];

export function ChatSkeleton(): JSX.Element {
  return (
    <div className="chat-skeleton" aria-hidden="true">
      {BUBBLES.map((b, idx) => (
        <div
          key={idx}
          className={`chat-skeleton__bubble chat-skeleton__bubble--${b.role}`}
          style={{ width: b.bubbleWidth }}
        >
          {b.lines.map((w, i) => (
            <Skeleton
              key={i}
              variant="custom"
              width={w}
              height={12}
              className="chat-skeleton__line"
            />
          ))}
        </div>
      ))}
    </div>
  );
}
