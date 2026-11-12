import { describe, expect, it } from 'vitest';
import { runErrorMessage } from '../lib';

describe('runErrorMessage', () => {
  it.each([
    ['budget_exceeded', 'O orçamento diário deste agente acabou.'],
    [
      'engine_auth',
      'O login do motor do agente não foi refeito em um dia, então a Seraphine parou de esperar. Entre no motor de novo e peça o trabalho outra vez.',
    ],
    [
      'provider_unavailable',
      'O provedor de IA do agente ficou fora do ar por mais de um dia e a Seraphine parou de tentar. Peça o trabalho de novo quando o serviço voltar.',
    ],
    [
      'plan_limit',
      'O limite de uso do plano do agente acabou e não voltou a tempo, então a Seraphine parou de esperar. Quando o limite voltar, peça o trabalho de novo.',
    ],
    ['engine_unavailable', 'O motor deste agente não está disponível neste computador.'],
    ['no_access', 'O agente não tem acesso a este projeto.'],
    ['agent_unavailable', 'O agente não existe ou foi desativado.'],
    ['project_unavailable', 'O projeto não existe ou foi arquivado.'],
    ['invalid_project_path', 'A pasta do projeto não é válida.'],
    ['approval_expired', 'O pedido de aprovação expirou sem resposta. Peça ao agente para tentar de novo.'],
    ['approval_tampered', 'O comando aprovado não é mais o mesmo que você viu, então nada foi executado.'],
    ['approval_limit', 'O agente pediu aprovações demais nesta execução.'],
    [
      'interrupted',
      'A Seraphine reiniciou enquanto o agente trabalhava e não conseguiu retomar o trabalho sozinha. Peça para ele continuar de onde parou.',
    ],
    [
      'interrupted_mid_action',
      'A Seraphine reiniciou no meio de uma ação do agente, que pode ter parado pela metade. Confira o que foi feito e peça de novo.',
    ],
  ])('maps %s to plain pt-BR without exposing the code', (code, text) => {
    expect(runErrorMessage(code)).toEqual({ text });
  });

  it('falls back to a generic sentence and returns the unknown code for debugging', () => {
    expect(runErrorMessage('erro interno: boom')).toEqual({ text: 'A execução falhou.', code: 'erro interno: boom' });
    expect(runErrorMessage(null)).toEqual({ text: 'A execução falhou.' });
  });
});
