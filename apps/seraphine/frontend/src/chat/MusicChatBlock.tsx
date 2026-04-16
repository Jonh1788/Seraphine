import { useState } from 'react';
import { MusicIcon, PlayIcon, PauseIcon } from '../icons/Icons';

export interface MusicCardData {
  title: string;
  artist: string;
  album_art: string;
  is_playing: boolean;
  url: string;
}

export interface MusicChatBlockProps {
  card: MusicCardData;
  /** Sends a user message through the same WS path the composer uses.
   *  The LLM then picks up the instruction and calls pause_music /
   *  resume_music. Kept as an opt-in callback so tests can omit it. */
  onSendMessage?: (content: string) => void;
}

export function MusicChatBlock({ card, onSendMessage }: MusicChatBlockProps): JSX.Element {
  // Optimistic toggle — user taps the button, we flip the icon
  // immediately and let the LLM confirm via a follow-up card.
  const [optimisticPlaying, setOptimisticPlaying] = useState<boolean | null>(null);
  const isPlaying = optimisticPlaying ?? card.is_playing;

  const title = (card.title || '').trim() || 'YouTube Music';
  const artist = (card.artist || '').trim();

  const handleToggle = (): void => {
    if (!onSendMessage) return;
    const next = !isPlaying;
    setOptimisticPlaying(next);
    onSendMessage(next ? 'retomar música' : 'pausar música');
  };

  return (
    <div className="rich-card rich-card--music music-chat-card">
      <div className="music-chat-card__row">
        {card.album_art ? (
          <img
            className="music-chat-card__art"
            src={card.album_art}
            alt={artist ? `Capa de ${title} — ${artist}` : `Capa de ${title}`}
            loading="lazy"
          />
        ) : (
          <span className="music-chat-card__art music-chat-card__art--placeholder">
            <MusicIcon size={20} />
          </span>
        )}
        <div className="music-chat-card__meta">
          <div className="rich-card__title music-chat-card__title">{title}</div>
          <div className="rich-card__subtitle music-chat-card__subtitle">
            {artist || 'YouTube Music'}
          </div>
        </div>
        {onSendMessage && (
          <button
            type="button"
            className="btn music-chat-card__toggle"
            onClick={handleToggle}
            aria-label={isPlaying ? 'Pausar música' : 'Retomar música'}
            title={isPlaying ? 'Pausar' : 'Tocar'}
          >
            {isPlaying ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
          </button>
        )}
      </div>
    </div>
  );
}
