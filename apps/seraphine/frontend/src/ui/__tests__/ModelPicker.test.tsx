import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import { ModelPicker } from '../ModelPicker';
import type { ModelPickerGroup } from '../ModelPicker';

/* Combobox de modelo do DESKTOP.
 *
 * O que ele existe para resolver: o backend parou de cortar o catálogo do
 * OpenRouter em 80 (o corte era alfabético — sumiam os `openai/*` e `qwen/*`
 * inteiros sem aviso nenhum na tela). O `<select>` chapado não dá conta de 400
 * opções, então a busca é o requisito, não um enfeite.
 *
 * E o contrato herdado da tela do mobile: o id sai daqui VERBATIM. Prefixar de
 * novo um id que já vem prefixado gravou `openrouter:openrouter:...` em
 * 2026-07-31 e derrubou o chat inteiro.
 */

const GRUPOS: ModelPickerGroup[] = [
  { label: 'Padrão', options: [{ id: 'cliproxy', name: 'Padrão — cliproxy / Claude' }] },
  {
    label: 'OpenRouter',
    options: [
      { id: 'openrouter:anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
      { id: 'openrouter:google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
      { id: 'openrouter:openai/gpt-5-mini', name: 'GPT-5 mini' },
      // O vendor do Auto Router chama-se literalmente `openrouter`: o id
      // legítimo tem a palavra duas vezes. Armadilha para qualquer "dedupe".
      { id: 'openrouter:openrouter/auto', name: 'Auto Router' },
    ],
  },
];

function montar(props: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
  const onChange = vi.fn();
  render(
    <ModelPicker
      label="Modelo do chat"
      value="cliproxy"
      groups={GRUPOS}
      onChange={onChange}
      {...props}
    />,
  );
  const campo = screen.getByRole('combobox', { name: 'Modelo do chat' }) as HTMLInputElement;
  return { campo, onChange };
}

const abrir = (campo: HTMLElement) => fireEvent.mouseDown(campo);

describe('ModelPicker', () => {
  it('fechado mostra o nome do selecionado, e não o id', () => {
    const { campo } = montar({ value: 'openrouter:google/gemini-3.5-flash' });
    expect(campo.value).toBe('Gemini 3.5 Flash');
    // Ausência afirmada: nada de listbox antes de abrir.
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(campo.getAttribute('aria-expanded')).toBe('false');
  });

  it('abre com o catálogo inteiro e diz quantos são', () => {
    const { campo } = montar();
    abrir(campo);

    expect(screen.getAllByRole('option')).toHaveLength(5);
    expect(screen.getByRole('option', { name: 'GPT-5 mini' })).toBeTruthy();
    // O contador é o antídoto do corte silencioso de 80 que existia no backend:
    // a tela agora AFIRMA o tamanho do catálogo.
    expect(screen.getByText('5 modelos')).toBeTruthy();
  });

  it('filtra por nome e por id, ignorando acento', () => {
    const { campo } = montar();
    abrir(campo);

    fireEvent.change(campo, { target: { value: 'gemini' } });
    expect(screen.getByRole('option', { name: 'Gemini 3.5 Flash' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Claude Sonnet 4.6' })).toBeNull();
    expect(screen.getByText('1 de 5')).toBeTruthy();

    // Pelo id — é assim que se acha um modelo cujo nome não se lembra.
    fireEvent.change(campo, { target: { value: 'openai/gpt' } });
    expect(screen.getByRole('option', { name: 'GPT-5 mini' })).toBeTruthy();

    // "padrao" sem acento acha "Padrão".
    fireEvent.change(campo, { target: { value: 'padrao' } });
    expect(screen.getByRole('option', { name: /Padrão/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'GPT-5 mini' })).toBeNull();
  });

  it('busca sem resultado: diz isso, e não é erro', () => {
    const { campo } = montar();
    abrir(campo);
    fireEvent.change(campo, { target: { value: 'zzz' } });

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/Nenhum modelo corresponde a "zzz"/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  /* ── o contrato: o id volta inteiro ─────────────────────────────── */

  it('devolve o id EXATO da opção clicada, sem reprefixar', () => {
    const { campo, onChange } = montar();
    abrir(campo);

    fireEvent.click(screen.getByRole('option', { name: 'Gemini 3.5 Flash' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const enviado = onChange.mock.calls[0][0];
    expect(enviado).toBe('openrouter:google/gemini-3.5-flash');
    expect(enviado).not.toMatch(/^openrouter:openrouter:/);
  });

  it('preserva o id do Auto Router, onde openrouter aparece duas vezes', () => {
    const { campo, onChange } = montar();
    abrir(campo);

    fireEvent.click(screen.getByRole('option', { name: 'Auto Router' }));
    expect(onChange).toHaveBeenCalledWith('openrouter:openrouter/auto');
  });

  it('não avisa quando o usuário reescolhe o que já está gravado', () => {
    const { campo, onChange } = montar({ value: 'openrouter:openai/gpt-5-mini' });
    abrir(campo);

    fireEvent.click(screen.getByRole('option', { name: 'GPT-5 mini' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull(); // mas fecha
  });

  /* ── teclado ────────────────────────────────────────────────────── */

  it('anda com as setas e escolhe com Enter', () => {
    const { campo, onChange } = montar();

    fireEvent.keyDown(campo, { key: 'ArrowDown' }); // abre
    expect(screen.getByRole('listbox')).toBeTruthy();

    // Abriu apontando para o selecionado (`cliproxy`, índice 0); uma seta desce
    // para o primeiro do OpenRouter.
    fireEvent.keyDown(campo, { key: 'ArrowDown' });
    fireEvent.keyDown(campo, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('openrouter:anthropic/claude-sonnet-4.6');
  });

  it('abre já apontando para o modelo gravado, não para o topo da lista', () => {
    const { campo, onChange } = montar({ value: 'openrouter:openai/gpt-5-mini' });

    fireEvent.keyDown(campo, { key: 'ArrowDown' }); // abre
    fireEvent.keyDown(campo, { key: 'Enter' });

    // Enter sem mexer nas setas confirma o próprio gravado — e por isso não
    // dispara onChange. Se abrisse no topo, teria trocado para o Padrão.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Escape fecha sem trocar nada e devolve o rótulo do gravado', () => {
    const { campo, onChange } = montar({ value: 'openrouter:google/gemini-3.5-flash' });
    abrir(campo);
    fireEvent.change(campo, { target: { value: 'gpt' } });

    fireEvent.keyDown(campo, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    // A busca digitada não pode ficar no campo fingindo ser o modelo escolhido.
    expect((campo as HTMLInputElement).value).toBe('Gemini 3.5 Flash');
  });

  it('clique fora fecha sem trocar nada', () => {
    const { campo, onChange } = montar();
    abrir(campo);
    expect(screen.getByRole('listbox')).toBeTruthy();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  /* ── valor fora do catálogo ─────────────────────────────────────── */

  it('mostra cru o id gravado que sumiu do catálogo, em vez do placeholder', () => {
    const { campo } = montar({ value: 'openrouter:foo/modelo-que-sumiu' });
    // Esconder faria o campo parecer vazio quando o chat está roteado por ele.
    expect(campo.value).toBe('openrouter:foo/modelo-que-sumiu');
  });

  it('desabilitado não abre', () => {
    const { campo } = montar({ disabled: true });
    abrir(campo);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  /* ── integração mínima com um pai controlado ────────────────────── */

  it('escolher atualiza o rótulo quando o pai propaga o novo valor', () => {
    function Pai() {
      const [v, setV] = useState('cliproxy');
      return <ModelPicker label="Modelo" value={v} groups={GRUPOS} onChange={setV} />;
    }
    render(<Pai />);
    const campo = screen.getByRole('combobox', { name: 'Modelo' }) as HTMLInputElement;

    abrir(campo);
    fireEvent.click(screen.getByRole('option', { name: 'GPT-5 mini' }));

    expect(campo.value).toBe('GPT-5 mini');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
