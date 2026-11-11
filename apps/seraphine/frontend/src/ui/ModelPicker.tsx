/* Combobox de modelo com busca — a versão DESKTOP do seletor.
 *
 * Por que existe: `GET /deepsearch/models` devolve o catálogo INTEIRO da
 * OpenRouter (~400 modelos). Antes de 2026-08-02 o backend cortava em 80 —
 * depois de ordenar por nome, então o corte era alfabético e mudo: metade do
 * catálogo não existia para o usuário e nada na tela dizia isso. O corte saiu;
 * quem tem de dar conta de 400 opções é a UI, e a resposta é busca.
 *
 * O mobile já tinha a dele (`mobile/screens/SeletorModeloScreen.tsx`, lista
 * agrupada com campo de busca no topo). Este é o par de teclado/mouse: um
 * `<input role="combobox">` que filtra a lista enquanto se digita, usado nos
 * três pontos do desktop que listavam modelo num `<select>` chapado — modelo do
 * chat, fan-out/síntese da Pesquisa e tutor das Trilhas.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A REGRA, a mesma da tela do mobile: `option.id` sai daqui VERBATIM.
 *
 * Os ids do catálogo já vêm prefixados (`openrouter:<vendor>/<modelo>`), e
 * prefixar de novo grava `openrouter:openrouter:...`, o que em 2026-07-31
 * derrubou o chat inteiro (400 "is not a valid model ID"). Aqui nada deriva
 * valor de id para gravar: `onChange` recebe a string original, ponto.
 * ───────────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import './ModelPicker.css';

export interface ModelPickerOption {
  id: string;
  name: string;
  /** Aceita esforço de raciocínio. Vira um selo na linha: com 400 modelos, é
   *  informação de ESCOLHA — descobrir depois, no controle desabilitado da
   *  outra seção, custa uma ida e volta. */
  reasoning?: boolean;
}

export interface ModelPickerGroup {
  label: string;
  options: ModelPickerOption[];
}

interface ModelPickerProps {
  value: string;
  onChange: (id: string) => void;
  groups: ModelPickerGroup[];
  /** Nome acessível do campo (não há `<label>` embutido). */
  label: string;
  disabled?: boolean;
  /** Texto quando `value` é vazio e não casa com nenhuma opção. */
  placeholder?: string;
  className?: string;
}

/** Minúsculas sem acento: "padrao" tem de achar "Padrão". Mesma normalização
 *  da busca do mobile — buscar não pode depender de digitar o til. */
function norm(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function ModelPicker({
  value,
  onChange,
  groups,
  label,
  disabled = false,
  placeholder = 'Selecionar modelo…',
  className,
}: ModelPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;

  const todas = useMemo(() => groups.flatMap((g) => g.options), [groups]);

  /* O gravado pode não estar no catálogo (chave trocada, modelo fora do ar,
     valor de uma versão anterior do app). Mostrar o id cru é o único jeito
     honesto — cair no placeholder faria o campo parecer vazio quando não é. */
  const selecionada = todas.find((o) => o.id === value);
  const rotuloAtual = selecionada?.name ?? (value || '');

  const alvo = norm(query.trim());
  const filtrados = useMemo(() => {
    if (alvo === '') return groups.filter((g) => g.options.length > 0);
    return groups
      .map((g) => ({
        ...g,
        options: g.options.filter(
          (o) => norm(o.name).includes(alvo) || norm(o.id).includes(alvo),
        ),
      }))
      .filter((g) => g.options.length > 0);
  }, [groups, alvo]);

  /** Ordem de renderização achatada — é sobre ela que as setas andam. */
  const flat = useMemo(() => filtrados.flatMap((g) => g.options), [filtrados]);
  const total = todas.length;

  const fechar = useCallback((foco: boolean) => {
    setOpen(false);
    setQuery('');
    if (foco) inputRef.current?.focus();
  }, []);

  const abrir = useCallback(() => {
    if (disabled || open) return;
    setQuery('');
    setOpen(true);
    // Abre já apontando para o selecionado: a primeira seta continua de onde
    // o usuário está, não do topo de uma lista de 400.
    const i = todas.findIndex((o) => o.id === value);
    setActive(i >= 0 ? i : 0);
  }, [disabled, open, todas, value]);

  const escolher = useCallback(
    (option: ModelPickerOption) => {
      fechar(true);
      // `option.id` inteiro, sem concatenar prefixo — ver o cabeçalho.
      if (option.id !== value) onChange(option.id);
    },
    [fechar, onChange, value],
  );

  // Clique fora fecha. `mousedown` (e não `click`) para o fechamento acontecer
  // antes de qualquer clique em outro controle da tela.
  useEffect(() => {
    if (!open) return;
    const aoApontar = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) fechar(false);
    };
    document.addEventListener('mousedown', aoApontar);
    return () => document.removeEventListener('mousedown', aoApontar);
  }, [open, fechar]);

  /** `scrollIntoView` não existe no jsdom — nenhum teste pode quebrar por isso. */
  const trazerParaVista = (el: Element | null | undefined) => {
    if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
      (el as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  };

  // Mantém o item ativo visível ao andar com as setas.
  useEffect(() => {
    if (!open) return;
    trazerParaVista(listRef.current?.querySelector('[data-ativo="true"]'));
  }, [open, active]);

  // O popover é absoluto DENTRO de containers que rolam (a gaveta de ajustes
  // tem `overflow-y: auto`): abrir perto do fim cortaria a lista na borda.
  useEffect(() => {
    if (!open) return;
    trazerParaVista(rootRef.current?.querySelector('.mp__pop'));
  }, [open]);

  const aoTeclar = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) {
          abrir();
          return;
        }
        if (flat.length === 0) return;
        setActive((i) => {
          const proximo = e.key === 'ArrowDown' ? i + 1 : i - 1;
          return Math.min(Math.max(proximo, 0), flat.length - 1);
        });
        return;
      }
      if (e.key === 'Enter') {
        if (!open) return;
        e.preventDefault();
        const alvoOpt = flat[active];
        if (alvoOpt) escolher(alvoOpt);
        return;
      }
      if (e.key === 'Escape') {
        if (!open) return;
        e.preventDefault();
        fechar(true);
        return;
      }
      if (e.key === 'Tab' && open) fechar(false);
    },
    [open, abrir, flat, active, escolher, fechar],
  );

  const idOpcao = (i: number) => `${baseId}-o${i}`;
  let indice = -1; // índice contínuo através dos grupos, para as setas

  return (
    <div className={`mp${className ? ` ${className}` : ''}`} ref={rootRef}>
      <div className="mp__campo">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          className="mp__input"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && flat[active] ? idOpcao(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          placeholder={open ? 'Buscar modelo…' : placeholder}
          value={open ? query : rotuloAtual}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onMouseDown={() => (open ? fechar(false) : abrir())}
          onKeyDown={aoTeclar}
        />
        <span className="mp__caret" aria-hidden="true" />
      </div>

      {open && (
        <div className="mp__pop">
          <ul className="mp__lista" id={listId} role="listbox" aria-label={label} ref={listRef}>
            {filtrados.map((g) => (
              <li key={g.label} className="mp__grupo" role="presentation">
                <p className="mp__grupo-rotulo">
                  {g.label}
                  <span className="mp__grupo-n">{g.options.length}</span>
                </p>
                <ul className="mp__grupo-lista" role="group" aria-label={g.label}>
                  {g.options.map((o) => {
                    indice += 1;
                    const i = indice;
                    const ativo = i === active;
                    return (
                      <li
                        key={o.id}
                        id={idOpcao(i)}
                        role="option"
                        aria-selected={o.id === value}
                        aria-label={o.name}
                        data-ativo={ativo ? 'true' : undefined}
                        className={`mp__opcao${ativo ? ' mp__opcao--ativa' : ''}${
                          o.id === value ? ' mp__opcao--sel' : ''
                        }`}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => escolher(o)}
                      >
                        <span className="mp__opcao-nome">{o.name}</span>
                        {o.reasoning && (
                          <span className="mp__opcao-selo" title="aceita esforço de raciocínio">
                            raciocínio
                          </span>
                        )}
                        {/* O id é o desempate: com 400 modelos há nomes quase
                            iguais, e é ele que a busca também casa. */}
                        {o.id && o.id !== o.name && (
                          <span className="mp__opcao-id" aria-hidden="true">{o.id}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>

          <p className="mp__rodape" role="status">
            {flat.length === 0
              ? `Nenhum modelo corresponde a "${query.trim()}".`
              : alvo === ''
                ? `${total} ${total === 1 ? 'modelo' : 'modelos'}`
                : `${flat.length} de ${total}`}
          </p>
        </div>
      )}
    </div>
  );
}
