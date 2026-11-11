import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EffortPicker } from '../EffortPicker';

/* Escala de esforço de raciocínio, compartilhada desktop/mobile.
 *
 * O risco desta tela é AFIRMAR ALGO FALSO. Um controle ligado num modelo que
 * não raciocina promete um efeito que não existe; e "Desligado" marcado quando
 * há um esforço gravado fora da escala (o backend aceita `minimal` e `xhigh`,
 * que a UI não oferece) mentiria na direção contrária. Os dois casos têm teste.
 */

describe('EffortPicker', () => {
  it('mostra a escala inteira e marca o valor gravado', () => {
    render(<EffortPicker value="high" onChange={vi.fn()} suportado />);

    const nomes = screen.getAllByRole('button').map((b) => b.textContent);
    expect(nomes).toEqual(['Desligado', 'Baixo', 'Médio', 'Alto', 'Máximo']);

    expect(screen.getByRole('button', { name: 'Alto' }).getAttribute('aria-pressed')).toBe('true');
    // Ausência afirmada: só um marcado.
    expect(
      screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true'),
    ).toHaveLength(1);
  });

  it('desligado é um valor de verdade, e é o default', () => {
    render(<EffortPicker value="" onChange={vi.fn()} suportado />);
    expect(screen.getByRole('button', { name: 'Desligado' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('emite o nível escolhido, e `` ao desligar', () => {
    const onChange = vi.fn();
    render(<EffortPicker value="" onChange={onChange} suportado />);

    fireEvent.click(screen.getByRole('button', { name: 'Máximo' }));
    expect(onChange).toHaveBeenCalledWith('max');

    fireEvent.click(screen.getByRole('button', { name: 'Desligado' }));
    // Voltar atrás tem de ser possível: `''` é como o usuário desliga.
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('modelo sem suporte: desabilita e DIZ o porquê', () => {
    const onChange = vi.fn();
    render(
      <EffortPicker
        value=""
        onChange={onChange}
        suportado={false}
        motivoNaoSuportado="GPT-4o mini não aceita esforço de raciocínio."
      />,
    );

    for (const b of screen.getAllByRole('button')) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByText(/GPT-4o mini não aceita/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Alto' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('esforço gravado fora da escala não marca Desligado — ele avisa', () => {
    /* O backend valida seis níveis (`minimal` e `xhigh` inclusive) e a UI
       oferece cinco. Marcar "Desligado" aqui afirmaria que não há esforço
       ativo, quando há. */
    render(<EffortPicker value="xhigh" onChange={vi.fn()} suportado />);

    expect(
      screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true'),
    ).toHaveLength(0);
    expect(screen.getByText(/fora da escala desta tela/)).toBeTruthy();
    expect(screen.getByText('xhigh')).toBeTruthy();
  });

  it('disabled explícito (salvando) não muda a marcação', () => {
    render(<EffortPicker value="low" onChange={vi.fn()} suportado disabled />);
    expect(screen.getByRole('button', { name: 'Baixo' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('button', { name: 'Baixo' }) as HTMLButtonElement).disabled).toBe(true);
    // Desabilitado por estar salvando NÃO é o mesmo que sem suporte: nada de
    // dizer que o modelo não aceita quando ele aceita.
    expect(screen.queryByText(/não aceita/)).toBeNull();
  });
});
