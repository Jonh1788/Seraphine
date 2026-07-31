import { describe, it, expect } from 'vitest';
import { SCREENS, SCREEN_KEYS } from '../screens/registry';

describe('registry de telas', () => {
  // 18, e não as 19 do plano: o estado vazio do chat deixou de ser chave de
  // navegação e virou um bloco dentro do `ChatScreen` (Task 28).
  it('tem uma entrada para cada tela do handoff', () => {
    expect(SCREEN_KEYS.length).toBe(18);
  });
  it('toda chave aponta para um componente', () => {
    for (const k of SCREEN_KEYS) expect(SCREENS[k]).toBeTruthy();
  });
  it('não tem chave duplicada', () => {
    expect(new Set(SCREEN_KEYS).size).toBe(SCREEN_KEYS.length);
  });
});
