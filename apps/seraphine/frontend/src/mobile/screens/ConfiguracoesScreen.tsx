import type { ScreenProps } from './registry';

/** PLACEHOLDER — substituído pela task da tela (plano mobile v3).
 *
 *  Existe para a chave poder entrar na `registry.ts` antes das telas, de
 *  modo que nenhuma task da Fase 1 precise editar aquele arquivo. Arquivo
 *  compartilhado entre agentes concorrentes é acidente esperando: nesta
 *  onda já custou dois commits desfeitos.
 *
 *  Diz o que é e o que falta, em vez de fingir tela vazia. */
export function ConfiguracoesScreen({ onBack }: ScreenProps) {
  return (
    <div className="ms-placeholder">
      {onBack && (
        <button type="button" aria-label="Voltar" onClick={() => onBack()}>
          &lsaquo;
        </button>
      )}
      <p>Configurações — ainda não implementada.</p>
    </div>
  );
}
