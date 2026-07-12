export function normalize(s: string): string {
  return (s || '').trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

export function checkMCQ(answerIdx: number | undefined, chosen: number): boolean {
  return answerIdx !== undefined && chosen === answerIdx;
}

export function checkCloze(answers: string[] | undefined, input: string): boolean {
  const n = normalize(input);
  return !!answers && answers.some((a) => normalize(a) === n);
}

export function checkMatchPairs(pairs: [string, string][], mapping: Record<number, number>): boolean {
  // mapping: índice do lado esquerdo → índice escolhido do lado direito
  return pairs.every((_, i) => mapping[i] === i);
}

export function checkSteps(steps: string[], ordered: string[]): boolean {
  return steps.length === ordered.length && steps.every((s, i) => s === ordered[i]);
}
