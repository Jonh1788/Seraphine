/** Matches avatar animation triggers like [anim:acenar]. */
export const ANIM_TAG_RE = /\[anim:([a-z0-9_-]+)\]/gi;

export function extractAnimTags(text: string): string[] {
  const re = new RegExp(ANIM_TAG_RE.source, ANIM_TAG_RE.flags);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1].toLowerCase());
  return out;
}

export function stripAnimTags(text: string): string {
  return text.replace(new RegExp(ANIM_TAG_RE.source, ANIM_TAG_RE.flags), '');
}
