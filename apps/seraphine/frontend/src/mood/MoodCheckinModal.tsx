import { useState } from 'react';
import { motion } from 'framer-motion';
import { XIcon } from '../icons/Icons';
import { postMoodCheckin } from './api';
import {
  CHECKIN_MOODS,
  MOOD_DEFAULTS,
  MOOD_LABELS,
  moodColor,
} from './types';

export interface MoodCheckinModalProps {
  onClose: () => void;
  onCheckinDone: () => void;
}

export function MoodCheckinModal({
  onClose,
  onCheckinDone,
}: MoodCheckinModalProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSelect = async (label: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const defaults = MOOD_DEFAULTS[label];
    try {
      await postMoodCheckin(label, defaults?.valence, defaults?.arousal);
      onCheckinDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="mood-checkin-overlay" onClick={onClose}>
      <motion.div
        className="mood-checkin"
        initial={{ opacity: 0, scale: 0.95, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 12 }}
        transition={{ duration: 0.2 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mood-checkin__header">
          <span className="mood-checkin__title">Como voce esta?</span>
          <button
            type="button"
            className="mood-checkin__close"
            onClick={onClose}
            aria-label="Fechar"
          >
            <XIcon size={16} />
          </button>
        </div>

        <div className="mood-checkin__grid">
          {CHECKIN_MOODS.map((label) => {
            const color = moodColor(label);
            const displayName = MOOD_LABELS[label] ?? label;
            return (
              <button
                key={label}
                type="button"
                className="mood-checkin__option"
                disabled={busy}
                onClick={() => void handleSelect(label)}
              >
                <span
                  className="mood-checkin__dot"
                  style={{ background: color }}
                  aria-hidden
                />
                <span className="mood-checkin__label">{displayName}</span>
              </button>
            );
          })}
        </div>

        {error && <div className="mood-checkin__error">{error}</div>}
      </motion.div>
    </div>
  );
}
