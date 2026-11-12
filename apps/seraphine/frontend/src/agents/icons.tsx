/** Small icons the agents space and the new sidebar need on top of `icons/Icons.tsx`. */
interface IconProps {
  size?: number;
  className?: string;
}

const base = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
  focusable: false as const,
};

export function BotIcon({ size = 18, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base}>
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 4v4M9.5 13v1.5M14.5 13v1.5" />
    </svg>
  );
}

export function HomeIcon({ size = 18, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base}>
      <path d="M4 11l8-7 8 7" />
      <path d="M6 10v9h12v-9" />
    </svg>
  );
}

export function ShieldCheckIcon({ size = 18, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base}>
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
      <path d="M9 12l2.2 2.2L15.5 10" />
    </svg>
  );
}

export function UsersIcon({ size = 18, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19c0-3.2 2.7-5 6-5s6 1.8 6 5" />
      <path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.3c1.7.6 3 2 3 4.7" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function ChevronRightSmallIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function FolderIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base}>
      <path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function StopIcon({ size = 13, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

export function TickIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2.4}>
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

/** Two bars: the work was paused by something outside the agent. */
export function PauseIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2.4}>
      <path d="M9 6v12M15 6v12" />
    </svg>
  );
}

/** Cloud with a slash: the provider is out of reach. */
export function CloudOffIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M7 18h10a4 4 0 0 0 1.2-7.8A6 6 0 0 0 6.6 9.3 4.5 4.5 0 0 0 7 18z" />
      <path d="M4 4l16 16" />
    </svg>
  );
}

/** Hourglass: a usage limit that renews later. */
export function HourglassIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M7 4h10M7 20h10M8 4v3.5L12 12l-4 4.5V20M16 4v3.5L12 12l4 4.5V20" />
    </svg>
  );
}

/** Key: the owner has to sign in again. */
export function KeyIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <circle cx="8" cy="15" r="3.5" />
      <path d="M10.5 12.5L19 4M16 7l3 3" />
    </svg>
  );
}

/** Circular arrow: picked up again by itself. */
export function RestartIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M4 12a8 8 0 1 0 2.5-5.8" />
      <path d="M4 4.5v4h4" />
    </svg>
  );
}

/** Clock: waiting for the agent's next pause. */
export function ClockIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.5l3 1.8" />
    </svg>
  );
}

/** Circle with an exclamation mark: something did not happen (a message was never read). */
export function InfoIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v5M12 16.2v.1" />
    </svg>
  );
}

/** Envelope: messages the agent read, or that wait for it. */
export function InboxIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <rect x="4" y="6" width="16" height="12" rx="2.5" />
      <path d="M5 8l7 5 7-5" />
    </svg>
  );
}

/** Bar against a wall: the agent reached its limit of actions. */
export function LimitIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M4 12h11M11 8l4 4-4 4M20 5v14" />
    </svg>
  );
}

/** Two arrows chasing each other: the same step over and over. */
export function LoopIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M17 4l3 3-3 3M20 7H8a4 4 0 0 0-4 4M7 20l-3-3 3-3M4 17h12a4 4 0 0 0 4-4" />
    </svg>
  );
}

/** Pulse that went flat: the engine stopped answering. */
export function SilenceIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M3 12h4l2-5 3 10 2-5h2M18 12h3" />
    </svg>
  );
}

/** Stopwatch: one stretch of work lasted too long. */
export function TimerIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <circle cx="12" cy="13" r="7" />
      <path d="M12 9.5V13l2.5 1.5M9.5 3h5" />
    </svg>
  );
}

/** Sheet with lines: the owner's notes. */
export function NotesIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M7 3.5h8l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-10.5A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z" />
      <path d="M9 12h6M9 15.5h6M15 3.5v4h4" />
    </svg>
  );
}

/** Open book: the wiki. */
export function BookIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M12 6.5C10.5 5 8 4.5 4.5 4.5v13c3.5 0 6 .5 7.5 2 1.5-1.5 4-2 7.5-2v-13c-3.5 0-6 .5-7.5 2z" />
      <path d="M12 6.5v13" />
    </svg>
  );
}

/** Head with a spark: the personal memory. */
export function MemoryIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M12 4a6.5 6.5 0 0 0-4 11.6V19h7v-2.5h1.5a1.5 1.5 0 0 0 1.5-1.5v-2l1.5-1.5-1.5-1.5A6.5 6.5 0 0 0 12 4z" />
      <path d="M12 8.5v4M10 10.5h4" />
    </svg>
  );
}

/** Small spanner: any other tool of the Seraphine. */
export function ToolIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M14.5 6.5a4 4 0 0 0 4.9 4.9L10 20.8a2.1 2.1 0 0 1-3-3l9.4-9.4A4 4 0 0 0 14.5 6.5z" />
    </svg>
  );
}

/** Checklist: the tasks of a project. */
export function TasksIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M4.5 7l1.8 1.8L9.5 5.5M4.5 16l1.8 1.8 3.2-3.3M13 7h7M13 16.5h7" />
    </svg>
  );
}

/** Bell: reminders. */
export function BellIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15zM10 20.5h4" />
    </svg>
  );
}

/** Speech bubble with a question mark: the agent asked the owner something. */
export function QuestionIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-6.5L8 20.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z" />
      <path d="M10 9.8a2 2 0 1 1 2.9 1.8c-.6.3-.9.7-.9 1.4M12 14.6v.1" />
    </svg>
  );
}

/** One icon per group of the Seraphine's tools (notes, wiki, memory...); a spanner for a group it does not know. */
export function ToolGroupIcon({ group, ...props }: IconProps & { group: string | undefined }): JSX.Element {
  if (group === 'project_tasks') return <TasksIcon {...props} />;
  if (group === 'reminders') return <BellIcon {...props} />;
  if (group === 'notes') return <NotesIcon {...props} />;
  if (group === 'wiki') return <BookIcon {...props} />;
  if (group === 'memory') return <MemoryIcon {...props} />;
  return <ToolIcon {...props} />;
}

/** Speech bubble with a plus: a new conversation. */
export function ChatNewIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-6.5L8 20.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z" />
      <path d="M12 8.5v5M9.5 11h5" />
    </svg>
  );
}

/** Speech bubble with an arrow: the conversation goes on from where it stopped. */
export function ChatContinueIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-6.5L8 20.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z" />
      <path d="M8.5 11h6M12.5 8.5l2.5 2.5-2.5 2.5" />
    </svg>
  );
}

/** Wifi with a slash: the live channel is down. */
export function WifiOffIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...base} strokeWidth={2}>
      <path d="M5 12.5a10 10 0 0 1 4-2.2M19 12.5a10 10 0 0 0-3-1.9M8.5 16a5 5 0 0 1 7 0M12 19.5v.1M4 4l16 16" />
    </svg>
  );
}
