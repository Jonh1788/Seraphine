/* Seletor de esforço de raciocínio — compartilhado desktop/mobile.
 *
 * A OpenRouter aceita `reasoning: {effort}` e traduz para cada provedor: nos
 * modelos da OpenAI vira o nível nativo, nos da Anthropic e Gemini vira
 * orçamento de tokens de pensamento. Quem aceita é o próprio catálogo que diz
 * (`supported_parameters` → `ModelOption.reasoning`), e é por isso que este
 * controle recebe `suportado`: oferecer o ajuste num modelo que não raciocina
 * seria prometer um efeito que não existe.
 *
 * `''` é desligado, e desligado significa NÃO MANDAR o parâmetro — o modelo
 * fica no comportamento padrão dele. Não é o mesmo que o `none` da OpenRouter,
 * que desliga o raciocínio de quem pensa por padrão; misturar os dois num
 * controle só faria "Desligado" significar duas coisas.
 *
 * Um botão por nível, e não um `<select>`: são cinco opções ordenadas numa
 * escala, e ver a escala inteira é a informação. Serve ao polegar e ao mouse
 * pelo mesmo motivo (alvos de 44px, nenhum menu para abrir).
 */

import { EFFORTS, EFFORT_LABELS } from '../research/types';
import type { Effort } from '../research/types';
import './EffortPicker.css';

interface EffortPickerProps {
  value: Effort | string;
  onChange: (e: Effort) => void;
  /** O modelo selecionado aceita raciocínio? Falso desabilita e explica. */
  suportado: boolean;
  disabled?: boolean;
  /** Texto do aviso quando `suportado` é falso (o nome do modelo entra aqui). */
  motivoNaoSuportado?: string;
  className?: string;
}

export function EffortPicker({
  value,
  onChange,
  suportado,
  disabled = false,
  motivoNaoSuportado,
  className,
}: EffortPickerProps): JSX.Element {
  const inativo = disabled || !suportado;
  /* Um valor gravado que não está na escala (o backend aceita `minimal` e
     `xhigh`, que a UI não oferece) não pode marcar botão nenhum — nem, pior,
     marcar "Desligado" e mentir que não há esforço ativo. */
  const conhecido = (EFFORTS as readonly string[]).includes(value);

  return (
    <div className={`efp${className ? ` ${className}` : ''}`}>
      <div className="efp__linha" role="group" aria-label="Esforço de raciocínio">
        {EFFORTS.map((e) => (
          <button
            key={e || 'off'}
            type="button"
            className={`efp__btn${value === e ? ' efp__btn--ativo' : ''}`}
            aria-pressed={value === e}
            disabled={inativo}
            onClick={() => onChange(e)}
          >
            {EFFORT_LABELS[e]}
          </button>
        ))}
      </div>

      {!suportado && (
        <p className="efp__nota" role="status">
          {motivoNaoSuportado ??
            'Este modelo não aceita esforço de raciocínio, então o ajuste não teria efeito.'}
        </p>
      )}
      {suportado && !conhecido && (
        <p className="efp__nota" role="status">
          Esforço gravado: <code>{value}</code> — fora da escala desta tela.
        </p>
      )}
    </div>
  );
}
