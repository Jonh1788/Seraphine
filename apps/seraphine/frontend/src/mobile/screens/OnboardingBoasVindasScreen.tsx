import { Orb } from '../Orb';
import type { ScreenProps } from './registry';
import './OnboardingBoasVindasScreen.css';

/* Tela ONBOARDING · BOAS-VINDAS (handoff linha 593) — o primeiro passo do
 * primeiro lançamento. Vem ANTES das abas: o `PhoneShell` monta esta tela no
 * lugar do shell enquanto `localStorage['seraphine.onboarding.done']` não
 * existe, e é ele quem grava a flag no último passo.
 *
 * Duas consequências de o shell montar isto FORA do `.mshell__content`:
 *  1. a tela não herda `flex:1`, rolagem nem safe area — o CSS daqui é dono
 *     dos três (ver `.ms-onb`);
 *  2. avançar é `props.onDone()`, e nada além disso. Uma flag própria aqui
 *     brigaria com a do shell e travaria o app no onboarding.
 *
 * O orbe é o compartilhado (`<Orb/>` → `.morb` + `orbFloat` de
 * `mobile/obsidian.css`); o anel usa `ringPulse`, o keyframe global de
 * `styles.css`. Nada de orbe nem de keyframe redefinido aqui.
 */

/** Passos REAIS do fluxo (o shell tem dois: boas-vindas e permissões). O
 *  handoff desenha três pontos, mas não existe um terceiro passo — três
 *  pontos prometeriam uma tela que nunca chega, e o último nunca acenderia.
 *  Fidelidade ao desenho pára onde ela vira mentira sobre o fluxo. */
const PASSOS = 2;

export function OnboardingBoasVindasScreen({ onDone }: ScreenProps) {
  // "Já uso no Mac — sincronizar": Mac e iPhone falam com o MESMO backend, e a
  // conta é a mesma — não há o que parear. E as permissões do passo seguinte
  // são por aparelho, então quem já usa no Mac ainda precisa delas. Por isso o
  // atalho avança o fluxo em vez de pular para o fim ou virar link morto.
  const avancar = () => onDone?.();

  return (
    <div className="ms-onb">
      <div className="ms-onb-palco">
        <div className="ms-onb-orbe">
          <span className="ms-onb-anel" aria-hidden="true" />
          <span className="ms-onb-brilho" aria-hidden="true" />
          <Orb size={148} float />
        </div>

        <div>
          <h1 className="ms-onb-titulo">Oi, eu sou a<br />Seraphine</h1>
          <p className="ms-onb-sub">
            Sua assistente pessoal — agenda, tarefas, finanças, hábitos e
            aprendizado, tudo numa conversa.
          </p>
        </div>

        <div className="ms-onb-pontos" aria-hidden="true">
          {Array.from({ length: PASSOS }, (_, i) => (
            <span
              key={i}
              className={`ms-onb-ponto${i === 0 ? ' ms-onb-ponto--ativo' : ''}`}
            />
          ))}
        </div>
      </div>

      <div className="ms-onb-rodape">
        <button type="button" className="ms-onb-cta" onClick={avancar}>
          Começar
        </button>
        <button type="button" className="ms-onb-link" onClick={avancar}>
          Já uso no Mac — sincronizar
        </button>
      </div>
    </div>
  );
}
