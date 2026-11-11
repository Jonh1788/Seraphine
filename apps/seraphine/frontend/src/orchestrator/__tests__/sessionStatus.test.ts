import { describe, expect, it } from 'vitest';
import {
  deriveStatus, RUNNING_WINDOW_MS, YOUR_TURN_WINDOW_MS, type StatusInput,
} from '../sessionStatus';

const NOW = 1_800_000_000_000;

function input(over: Partial<StatusInput> = {}): StatusInput {
  return {
    lastModifiedMs: NOW - 10 * 60 * 1000, // 10 min atrás: nem fresco, nem antigo
    hasPendingPermission: false,
    hasResultEvent: false,
    endedCleanly: false,
    now: NOW,
    ...over,
  };
}

describe('deriveStatus — um caso por estado', () => {
  it('permissão pendente -> waiting', () => {
    expect(deriveStatus(input({ hasPendingPermission: true }))).toBe('waiting');
  });

  it('evento result no stream vivo -> done', () => {
    expect(deriveStatus(input({ hasResultEvent: true }))).toBe('done');
  });

  it('escreveu agora há pouco -> running', () => {
    expect(deriveStatus(input({ lastModifiedMs: NOW - 30_000 }))).toBe('running');
  });

  it('terminou limpo e foi recente -> your_turn', () => {
    expect(deriveStatus(input({ endedCleanly: true }))).toBe('your_turn');
  });

  it('nada disso -> idle', () => {
    expect(deriveStatus(input())).toBe('idle');
  });
});

describe('deriveStatus — o bug que motivou tudo', () => {
  it('sessão fresca é running mesmo sem ter sido criada por esta instância', () => {
    // `owned` nem existe na entrada: era exatamente o campo que fazia uma
    // sessão de terminal, trabalhando agora, aparecer como OCIOSA.
    expect(deriveStatus(input({ lastModifiedMs: NOW - 5_000 }))).toBe('running');
  });
});

describe('deriveStatus — fronteiras', () => {
  it('1 ms dentro da janela de running ainda é running', () => {
    expect(deriveStatus(input({ lastModifiedMs: NOW - RUNNING_WINDOW_MS + 1 }))).toBe('running');
  });

  it('1 ms fora da janela de running não é running', () => {
    expect(deriveStatus(input({ lastModifiedMs: NOW - RUNNING_WINDOW_MS - 1 }))).not.toBe('running');
  });

  it('1 ms dentro da janela de your_turn ainda é your_turn', () => {
    expect(deriveStatus(input({
      endedCleanly: true, lastModifiedMs: NOW - YOUR_TURN_WINDOW_MS + 1,
    }))).toBe('your_turn');
  });

  it('1 ms fora da janela de your_turn vira idle', () => {
    expect(deriveStatus(input({
      endedCleanly: true, lastModifiedMs: NOW - YOUR_TURN_WINDOW_MS - 1,
    }))).toBe('idle');
  });

  it('antigo e interrompido é idle, não your_turn', () => {
    expect(deriveStatus(input({ endedCleanly: false, lastModifiedMs: NOW - 60_000 }))).toBe('running');
    expect(deriveStatus(input({ endedCleanly: false, lastModifiedMs: NOW - 30 * 60 * 1000 }))).toBe('idle');
  });
});

describe('deriveStatus — as janelas valem 2min e 6h, escritas por extenso', () => {
  // As fronteiras acima medem cada janela com a própria constante que a
  // implementação usa, então mutar a constante muta o oráculo junto: esticar
  // YOUR_TURN_WINDOW_MS de 6h para 600h — uma sessão de três dias lida como
  // SUA VEZ — passava na suíte inteira. Trocar `age <` por `age <=` nas duas
  // janelas também. Estes números são literais de propósito. NÃO trocar por
  // expressões sobre RUNNING_WINDOW_MS / YOUR_TURN_WINDOW_MS.

  it('2 min cravados já não é running', () => {
    // 2 * 60 * 1000. A comparação é `<`, não `<=`: no msec exato já saiu.
    expect(deriveStatus(input({ lastModifiedMs: NOW - 120_000 }))).toBe('idle');
  });

  it('1 ms antes dos 2 min ainda é running', () => {
    expect(deriveStatus(input({ lastModifiedMs: NOW - 119_999 }))).toBe('running');
  });

  it('6 h cravadas já não é your_turn', () => {
    // 6 * 60 * 60 * 1000.
    expect(deriveStatus(input({
      endedCleanly: true, lastModifiedMs: NOW - 21_600_000,
    }))).toBe('idle');
  });

  it('1 ms antes das 6 h ainda é your_turn', () => {
    expect(deriveStatus(input({
      endedCleanly: true, lastModifiedMs: NOW - 21_599_999,
    }))).toBe('your_turn');
  });
});

describe('deriveStatus — precedência', () => {
  it('permissão pendente vence frescor', () => {
    expect(deriveStatus(input({
      hasPendingPermission: true, lastModifiedMs: NOW - 1_000,
    }))).toBe('waiting');
  });

  it('result vence frescor: a run acabou', () => {
    expect(deriveStatus(input({
      hasResultEvent: true, lastModifiedMs: NOW - 1_000,
    }))).toBe('done');
  });

  it('running vence your_turn quando as duas condições valem', () => {
    // Terminou limpo E acabou de escrever: pode estar começando o próximo turno.
    expect(deriveStatus(input({
      endedCleanly: true, lastModifiedMs: NOW - 1_000,
    }))).toBe('running');
  });

  it('permissão pendente vence result', () => {
    expect(deriveStatus(input({
      hasPendingPermission: true, hasResultEvent: true,
    }))).toBe('waiting');
  });
});
