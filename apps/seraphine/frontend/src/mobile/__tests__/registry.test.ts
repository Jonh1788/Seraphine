import { describe, it, expect } from 'vitest';
import { SCREENS, SCREEN_KEYS } from '../screens/registry';

describe('registry de telas', () => {
  it('tem uma entrada para cada tela do handoff', () => {
    expect(SCREEN_KEYS.length).toBe(19);
  });
  it('toda chave aponta para um componente', () => {
    for (const k of SCREEN_KEYS) expect(SCREENS[k]).toBeTruthy();
  });
  it('não tem chave duplicada', () => {
    expect(new Set(SCREEN_KEYS).size).toBe(SCREEN_KEYS.length);
  });
});
