import { describe, expect, it, vi } from 'vitest';

// `shouldFollow` é pura, mas importá-la carrega MaestroView inteiro — e os stores
// dele assinam eventos do Tauri já na carga do módulo, o que rejeita fora do app
// e sujaria a suíte com "Unhandled Rejection". Só os assinantes são neutralizados;
// o resto de `../api` continua real.
vi.mock('../api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  onAgentEvent: async () => () => {},
  onAgentExit: async () => () => {},
  onPermissionPending: async () => () => {},
}));

import { shouldFollow, FOLLOW_SLACK_PX } from '../MaestroView';

describe('shouldFollow', () => {
  it('no fim exato -> acompanha', () => {
    expect(shouldFollow({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it('dentro da folga -> acompanha', () => {
    expect(shouldFollow({
      scrollTop: 900 - FOLLOW_SLACK_PX + 1, scrollHeight: 1000, clientHeight: 100,
    })).toBe(true);
  });

  it('fora da folga -> não arrasta o usuário de volta', () => {
    expect(shouldFollow({
      scrollTop: 900 - FOLLOW_SLACK_PX - 1, scrollHeight: 1000, clientHeight: 100,
    })).toBe(false);
  });

  it('conteúdo menor que a janela -> acompanha', () => {
    expect(shouldFollow({ scrollTop: 0, scrollHeight: 80, clientHeight: 100 })).toBe(true);
  });
});

describe('shouldFollow — a folga vale 40px, escrito por extenso', () => {
  // Os casos acima medem a folga com `FOLLOW_SLACK_PX`, a mesma constante que
  // a implementação usa: mudar a constante muda o oráculo junto e o teste
  // continua verde. Zerá-la — que apaga a folga inteira, exatamente a
  // regressão que os 40px existem para impedir — passava na suíte toda.
  // Estes dois números são literais de propósito. NÃO trocar por expressões
  // sobre FOLLOW_SLACK_PX.

  // distância = scrollHeight - clientHeight - scrollTop = 1000 - 100 - 860.
  it('distância de exatamente 40px ainda acompanha', () => {
    expect(shouldFollow({ scrollTop: 860, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it('distância de 41px já não acompanha', () => {
    expect(shouldFollow({ scrollTop: 859, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
  });
});
