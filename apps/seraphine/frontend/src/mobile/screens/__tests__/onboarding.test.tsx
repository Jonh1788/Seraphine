import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* Onboarding (handoff linhas 593 e 615). Duas telas sem api de backend: o que
   elas consomem são PERMISSÕES do aparelho. Então o que se mocka aqui não é um
   `<modulo>/api.ts` e sim as pontes reais:
     - notificações → `@tauri-apps/plugin-notification` (registrado no alvo
       iOS) com queda para a Notification API do WKWebView;
     - microfone   → `navigator.permissions` para ler e `getUserMedia` para
       pedir (o alvo iOS não tem comando Rust de microfone — o webview trata
       áudio nativamente, e o Info.plist traz NSMicrophoneUsageDescription);
     - calendário  → NÃO EXISTE ponte. O teste tranca isso: o botão fica
       desabilitado, e nenhum caminho leva o cartão a "Permitido". */
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => false),
  requestPermission: vi.fn(async () => 'default'),
}));
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';

import { OnboardingBoasVindasScreen } from '../OnboardingBoasVindasScreen';
import { OnboardingPermissoesScreen } from '../OnboardingPermissoesScreen';
import { PhoneShell } from '../../PhoneShell';

/** Estado que `navigator.permissions.query` devolve, ou `null` para simular o
 *  Safari/WKWebView, que não implementa `microphone` na Permissions API. */
function stubPermissions(estado: PermissionState | null): void {
  if (estado === null) {
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn(async () => { throw new TypeError('microphone não suportado'); }) },
    });
    return;
  }
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: vi.fn(async () => ({ state: estado, addEventListener: vi.fn(), removeEventListener: vi.fn() })) },
  });
}

/** `getUserMedia` que concede (resolve com faixas) ou nega (rejeita). */
function stubMedia(concede: boolean, parar = vi.fn()): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => {
        if (!concede) throw new DOMException('NotAllowedError', 'NotAllowedError');
        return { getTracks: () => [{ stop: parar }] };
      }),
    },
  });
}

/** Remove a mediaDevices para simular um webview sem captura nenhuma. */
function semMedia(): void {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(isPermissionGranted).mockReset().mockResolvedValue(false);
  vi.mocked(requestPermission).mockReset().mockResolvedValue('default' as NotificationPermission);
  stubPermissions(null);
  semMedia();
  vi.stubGlobal('Notification', undefined);
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Liga a ponte Tauri: é o que decide se as notificações vão pelo plugin. */
function comTauri(): void {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
}

// ───────────────────────────── tela 17 ─────────────────────────────

describe('OnboardingBoasVindasScreen', () => {
  it('desenha o orbe, o título e a chamada do handoff', () => {
    const { container } = render(<OnboardingBoasVindasScreen onDone={vi.fn()} />);
    expect(screen.getByText(/Oi, eu sou a/)).toBeTruthy();
    expect(screen.getByText(/Sua assistente pessoal/)).toBeTruthy();
    // o orbe é o compartilhado (`.morb` de mobile/obsidian.css), com os 148px
    // do handoff — não uma cópia local
    const orbe = container.querySelector('.morb') as HTMLElement | null;
    expect(orbe).toBeTruthy();
    expect(orbe?.style.width).toBe('148px');
    expect(container.querySelector('.ms-onb-anel')).toBeTruthy();
  });

  it('mostra um ponto por passo REAL do fluxo, com o primeiro ativo', () => {
    const { container } = render(<OnboardingBoasVindasScreen onDone={vi.fn()} />);
    const pontos = container.querySelectorAll('.ms-onb-ponto');
    expect(pontos).toHaveLength(2); // boas-vindas + permissões: o shell tem dois
    expect(pontos[0].className).toContain('ms-onb-ponto--ativo');
    expect(pontos[1].className).not.toContain('ms-onb-ponto--ativo');
  });

  it('o "Começar" avança o fluxo pelo onDone do shell', () => {
    const onDone = vi.fn();
    render(<OnboardingBoasVindasScreen onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Começar' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('o atalho "Já uso no Mac" também avança, em vez de ser link morto', () => {
    const onDone = vi.fn();
    render(<OnboardingBoasVindasScreen onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: /Já uso no Mac/ }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('não quebra sem onDone (o registry passa a prop a todas as telas)', () => {
    render(<OnboardingBoasVindasScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Começar' }));
    expect(screen.getByText(/Oi, eu sou a/)).toBeTruthy();
  });
});

// ───────────────────────────── tela 18 ─────────────────────────────

describe('OnboardingPermissoesScreen', () => {
  it('desenha os três cartões, o toggle e o CTA', async () => {
    render(<OnboardingPermissoesScreen onDone={vi.fn()} />);
    expect(screen.getByText('Microfone')).toBeTruthy();
    expect(screen.getByText('Notificações')).toBeTruthy();
    expect(screen.getByText('Calendário')).toBeTruthy();
    expect(screen.getByText(/Wake word/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeTruthy();
    await waitFor(() => expect(screen.queryAllByLabelText('lendo a permissão')).toHaveLength(0));
  });

  it('conceder o microfone troca o cartão para "Permitido"', async () => {
    const parar = vi.fn();
    stubMedia(true, parar);
    render(<OnboardingPermissoesScreen onDone={vi.fn()} />);
    const botao = await screen.findByRole('button', { name: 'Permitir microfone' });
    fireEvent.click(botao);
    await waitFor(() => expect(screen.getByText('Permitido')).toBeTruthy());
    // o cartão concedido ganha o realce do handoff (borda accent)
    expect(document.querySelector('.ms-onb-perm-cartao--ok')).toBeTruthy();
    // e a faixa é solta: pedir permissão não pode deixar o mic ligado
    expect(parar).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Permitir microfone' })).toBeNull();
  });

  it('já concedido antes de abrir a tela: nasce "Permitido", sem botão', async () => {
    stubPermissions('granted');
    render(<OnboardingPermissoesScreen onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Permitido')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Permitir microfone' })).toBeNull();
  });

  it('negar lê como NEGADO, não como intocado, e diz onde reverter', async () => {
    stubMedia(false);
    render(<OnboardingPermissoesScreen onDone={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Permitir microfone' }));
    await waitFor(() => expect(screen.getByText('Negado')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/liberar em Ajustes/);
    expect(screen.queryByText('Permitido')).toBeNull();
  });

  it('sem captura de áudio no webview, o microfone se declara indisponível', async () => {
    render(<OnboardingPermissoesScreen onDone={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Permitir microfone' }));
    await waitFor(() => expect(screen.getByText(/microfone não está disponível/i)).toBeTruthy());
    expect(screen.queryByText('Permitido')).toBeNull();
  });

  it('notificações passam pelo plugin Tauri quando a ponte existe', async () => {
    comTauri();
    vi.mocked(requestPermission).mockResolvedValue('granted' as NotificationPermission);
    render(<OnboardingPermissoesScreen onDone={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Permitir notificações' }));
    await waitFor(() => expect(screen.getByText('Permitido')).toBeTruthy());
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('notificações já concedidas no plugin nascem permitidas', async () => {
    comTauri();
    vi.mocked(isPermissionGranted).mockResolvedValue(true);
    render(<OnboardingPermissoesScreen onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Permitido')).toBeTruthy());
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('sem Tauri, notificações caem na Notification API do webview', async () => {
    const pedir = vi.fn(async () => 'granted');
    vi.stubGlobal('Notification', Object.assign(function () {}, {
      permission: 'default',
      requestPermission: pedir,
    }));
    render(<OnboardingPermissoesScreen onDone={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Permitir notificações' }));
    await waitFor(() => expect(screen.getByText('Permitido')).toBeTruthy());
    expect(pedir).toHaveBeenCalledTimes(1);
    expect(requestPermission).not.toHaveBeenCalled(); // o plugin não foi tocado
  });

  it('o calendário assume que não tem ponte: botão desabilitado e nunca permitido', async () => {
    render(<OnboardingPermissoesScreen onDone={vi.fn()} />);
    const botao = await screen.findByRole('button', { name: 'Permitir calendário' });
    expect((botao as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/ainda não tem ponte com o Calendário/i)).toBeTruthy();
    fireEvent.click(botao);
    await waitFor(() => expect(screen.getByText('Calendário')).toBeTruthy());
    expect(screen.queryByText('Permitido')).toBeNull();
  });

  it('o toggle da wake word liga e persiste no mesmo lugar do resto do app', async () => {
    render(<OnboardingPermissoesScreen onDone={vi.fn()} />);
    const toggle = screen.getByRole('switch', { name: /Wake word/ });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(localStorage.getItem('seraphine.wakeWord')).toBe('true');
  });

  /* Esta é a tela do PRIMEIRO contato com o recurso. A frase entre aspas é
     contrato com o classificador embarcado (`ei_seraphine_v9.onnx`, limiar
     0.92), treinado em "Ei Seraphine": quem aprender outra frase aqui conclui
     que a wake word não funciona. Os três lugares são checados um a um porque
     falham separado — e cada um afirma as duas metades, já que só a positiva
     deixaria passar um texto que citasse as duas frases. */
  describe('a wake word é anunciada com a frase que o modelo escuta', () => {
    /** Deixa a leitura assíncrona de permissão assentar antes de terminar. */
    const assentar = () =>
      waitFor(() => expect(screen.queryAllByLabelText('lendo a permissão')).toHaveLength(0));

    it('a descrição do cartão do microfone cita a frase certa', async () => {
      render(<OnboardingPermissoesScreen onDone={vi.fn()} />);
      const desc = screen.getByText(/Pra conversa por voz/).textContent ?? '';
      expect(desc).toMatch(/ei seraphine/i);
      expect(desc).not.toMatch(/oi sera\b/i);
      await assentar();
    });

    it('o nome do toggle cita a frase certa', async () => {
      render(<OnboardingPermissoesScreen onDone={vi.fn()} />);
      const nome = screen.getByText(/Wake word/).textContent ?? '';
      expect(nome).toMatch(/ei seraphine/i);
      expect(nome).not.toMatch(/oi sera\b/i);
      await assentar();
    });

    // O rótulo do switch é o que o VoiceOver fala. Se ele guardar a frase antiga,
    // um usuário cego recebe a instrução errada pelo canal em que mais confia —
    // e, diferente do texto na tela, não há como conferir de relance.
    it('o aria-label do switch, que o VoiceOver lê, cita a frase certa', async () => {
      render(<OnboardingPermissoesScreen onDone={vi.fn()} />);
      const rotulo = screen.getByRole('switch').getAttribute('aria-label') ?? '';
      expect(rotulo).toMatch(/ei seraphine/i);
      expect(rotulo).not.toMatch(/oi sera\b/i);
      await assentar();
    });
  });

  it('o "Continuar" conclui o onboarding pelo onDone do shell', async () => {
    const onDone = vi.fn();
    render(<OnboardingPermissoesScreen onDone={onDone} />);
    await screen.findByRole('button', { name: 'Permitir microfone' }); // leitura assentou
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('o "Continuar" segue valendo com tudo negado — ninguém fica preso', async () => {
    stubMedia(false);
    const onDone = vi.fn();
    render(<OnboardingPermissoesScreen onDone={onDone} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Permitir microfone' }));
    await waitFor(() => expect(screen.getByText('Negado')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────── as duas juntas, no shell real ──────────────────────

/* O `shell-registry.test.tsx` prova o GATE com telas de mentira. Este prova o
   contrário: que as telas de verdade satisfazem o contrato do gate. Enquanto
   elas eram placeholders, todo perfil sem a flag (isto é, todos) parava numa
   tela sem saída e sem tab bar — este teste é o que tranca a regressão. */
describe('o onboarding real destrava o app', () => {
  it('boas-vindas → permissões → abas, com a flag gravada no fim', async () => {
    // Response de verdade: um literal {ok, json} faria qualquer helper que leia
    // `res.headers.get(...)` explodir para o ramo de erro parecendo sucesso.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const { container } = render(<PhoneShell />);
    expect(container.querySelector('.mtabbar')).toBeNull(); // o gate está de pé

    fireEvent.click(await screen.findByRole('button', { name: 'Começar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continuar' }));

    expect(localStorage.getItem('seraphine.onboarding.done')).toBe('1');
    await waitFor(() => expect(container.querySelector('.mtabbar')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull();
  });
});
