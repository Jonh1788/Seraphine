import { stripAnimTags } from './animTag';

/**
 * Where the "what the model said out loud" vs "what it thought" split lives.
 *
 * WHY THIS FILE EXISTS: the parser was a private function inside
 * `ChatView.tsx`, so the phone shell had no way to reach it and rendered the
 * raw stream — `<think>…</think>` showed up as literal text inside the bubble,
 * reasoning and answer glued together. Copying it into `mobile/` would have
 * given the same string two parsers, which is how the flat-backends list
 * already cost this project a wrong number on screen. So it moved here and the
 * two shells import it; there is exactly one definition of what a thinking
 * block is.
 */

/**
 * Strip ElevenLabs v3 audio tags from text before rendering in chat.
 * Tags like [laughs], [whispers], [excited tone] are rendered as real
 * emotion by the TTS server, but we don't want them to show up as
 * "[laughs]" literal brackets in the chat bubble. Uses a negative
 * lookahead on `(` so markdown links `[text](url)` are NOT touched.
 */
const AUDIO_TAG_RE = /\[[a-zà-ú][a-zà-ú ]{1,29}\](?!\()/gi;

export function stripAudioTags(text: string): string {
  return stripAnimTags(text.replace(AUDIO_TAG_RE, '')).replace(/ {2,}/g, ' ');
}

export interface Thinking {
  /** The reasoning, or `null` when the text carries none. */
  thinking: string | null;
  /** What is meant to be shown as the answer. */
  response: string;
  /** The closing tag arrived — while false, the block is still streaming. */
  thinkingDone: boolean;
}

/**
 * Parse assistant content that may contain thinking blocks in either
 * `<think>…</think>` (standard) or `<|channel>thought\n…<channel|>`
 * (Gemma 4 native) format.
 */
export function parseThinking(raw: string): Thinking {
  // Try Gemma 4 channel format first: <|channel>thought\n...<channel|>
  const gemmaOpen = '<|channel>thought';
  const gemmaClose = '<channel|>';
  const gemmaOpenIdx = raw.indexOf(gemmaOpen);
  if (gemmaOpenIdx !== -1) {
    const afterGemmaOpen = gemmaOpenIdx + gemmaOpen.length;
    const gemmaCloseIdx = raw.indexOf(gemmaClose, afterGemmaOpen);
    // Skip an optional leading \n after <|channel>thought
    const contentStart = raw[afterGemmaOpen] === '\n' ? afterGemmaOpen + 1 : afterGemmaOpen;
    if (gemmaCloseIdx === -1) {
      return {
        thinking: raw.slice(contentStart),
        response: raw.slice(0, gemmaOpenIdx),
        thinkingDone: false,
      };
    }
    return {
      thinking: raw.slice(contentStart, gemmaCloseIdx),
      response: raw.slice(0, gemmaOpenIdx) + raw.slice(gemmaCloseIdx + gemmaClose.length),
      thinkingDone: true,
    };
  }

  const openTag = '<think>';
  const closeTag = '</think>';
  const openIdx = raw.indexOf(openTag);
  if (openIdx === -1) return { thinking: null, response: raw, thinkingDone: false };

  const afterOpen = openIdx + openTag.length;
  const closeIdx = raw.indexOf(closeTag, afterOpen);

  if (closeIdx === -1) {
    // Still inside thinking — everything after <think> is thinking content
    return {
      thinking: raw.slice(afterOpen),
      response: '',
      thinkingDone: false,
    };
  }

  // Thinking is complete
  return {
    thinking: raw.slice(afterOpen, closeIdx),
    response: raw.slice(closeIdx + closeTag.length),
    thinkingDone: true,
  };
}
