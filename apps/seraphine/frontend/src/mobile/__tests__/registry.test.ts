import { describe, it, expect } from 'vitest';
import { SCREENS, SCREEN_KEYS } from '../screens/registry';

describe('registry de telas', () => {
  // 18 do handoff original + 6 do v3 = 24.
  //
  // As 18: eram 19 no plano da onda anterior; o estado vazio do chat deixou
  // de ser chave de navegação e virou um bloco dentro do `ChatScreen`.
  //
  // As 6 do v3: Configurações, Trilhas·lista, Planejamento, Seletor de
  // modelo e as duas de Custos. Os TRÊS MODAIS não entram — são
  // sobreposições sobre a tela atual, não destinos de navegação. Chave de
  // modal no registry foi o que, na onda anterior, fez o shell descartar
  // calado o callback de que o modal dependia (ele só repassa
  // `id/onBack/onOpen/onDone`), e um modal com autosave perderia o handler
  // de salvar sem erro de tipo.
  it('tem uma entrada para cada tela do handoff', () => {
    expect(SCREEN_KEYS.length).toBe(24);
  });
  it('toda chave aponta para um componente', () => {
    for (const k of SCREEN_KEYS) expect(SCREENS[k]).toBeTruthy();
  });
  it('não tem chave duplicada', () => {
    expect(new Set(SCREEN_KEYS).size).toBe(SCREEN_KEYS.length);
  });
});
