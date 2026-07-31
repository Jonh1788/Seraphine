import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PCMPlayback } from '../../audio/playback';
import type { SeraphineWS } from '../../ws/client';

/**
 * O DESLIGAR do motor de realtime — o microfone e o audio unit.
 *
 * O defeito que estes testes prendem: o controller só desmontava o VAD e a
 * sessão VPIO no ramo `if (!active)` do efeito. O cleanup do próprio efeito não
 * fazia nada além de marcar `cancelled`. Quem SUMISSE com o componente ainda
 * ligado — e é o caminho normal de saída: a `VozScreen` faz `setEncerrada(true)`
 * junto com o `onBack()`, então o pai desmonta no mesmo commit e o controller
 * nunca chega a ver `active === false` — deixava o microfone quente e o audio
 * unit segurando a entrada. No iPhone isso é o indicador de microfone aceso
 * depois de sair da tela de voz.
 *
 * A regra destes testes: NADA de flag de store. A prova é a CHAMADA de parada
 * no VAD e na sessão VPIO — foi por confiar numa flag (`realtimeActive`, que
 * fala do wake word e não do microfone) que o vazamento sobreviveu.
 */

const h = vi.hoisted(() => ({
  /** Ordem real das operações de desligamento, para prender o sequenciamento. */
  ordem: [] as string[],
  vadStop: vi.fn<() => Promise<void>>(),
  vadStart: vi.fn<() => Promise<void>>(),
  vadSuspende: vi.fn(),
  vadResume: vi.fn(),
  /** Callbacks que o controller entregou ao VAD (é por elas que se fala). */
  cb: null as Record<string, ((...a: never[]) => void) | undefined> | null,
  criouVad: 0,
  vpioStart: vi.fn<() => Promise<void>>(),
  vpioStop: vi.fn<() => Promise<void>>(),
  vpioCriadas: 0,
  vpioDisponivel: true,
}));

// O `VrmAvatar` constrói um WebGLRenderer no render — o jsdom não tem contexto
// WebGL. Fora do escopo desta correção (o desacoplamento do motor está agendado
// à parte), então aqui ele é um duplo vazio.
vi.mock('../../avatar/VrmAvatar', () => ({ VrmAvatar: () => null }));

vi.mock('../vad', () => ({
  createRealtimeVAD: vi.fn(async (opts: Record<string, (...a: never[]) => void>) => {
    h.cb = opts;
    h.criouVad += 1;
    return {
      start: h.vadStart,
      stop: h.vadStop,
      getAnalyser: () => null,
      isListening: () => true,
      suspendForPlayback: h.vadSuspende,
      resumeAfterPlayback: h.vadResume,
      isSuspended: () => false,
      getMicRms: () => 0,
    };
  }),
}));

vi.mock('../../audio/tauriVpio', () => {
  class SessaoVpioFalsa {
    start = h.vpioStart;
    stop = h.vpioStop;
    constructor() { h.vpioCriadas += 1; }
  }
  return {
    isTauriVpioAvailable: () => h.vpioDisponivel,
    TauriVpioSession: SessaoVpioFalsa,
  };
});

vi.mock('../../audio/sharedContext', () => ({
  warmSharedAudioContext: vi.fn(),
  getSharedAudioContext: vi.fn(),
}));

import { RealtimeController } from '../RealtimeController';
import { createRealtimeVAD } from '../vad';

/** Só a superfície do `PCMPlayback` que o controller toca. */
function playbackFalso() {
  return {
    ensureCtx: vi.fn(),
    getAnalyser: vi.fn(() => null),
    stop: vi.fn(() => { h.ordem.push('playback:stop'); }),
    flush: vi.fn(async () => {}),
    setVpioSink: vi.fn((sink: unknown) => {
      h.ordem.push(sink ? 'sink:vpio' : 'sink:null');
    }),
  };
}

/** Só a superfície do `SeraphineWS` que o controller usa. */
function wsFalso() {
  const enviadas: Record<string, unknown>[] = [];
  return {
    enviadas,
    send: vi.fn((m: Record<string, unknown>) => {
      enviadas.push(m);
      h.ordem.push(`ws:${String(m.type)}`);
    }),
    sendBinary: vi.fn(),
    onMessage: vi.fn(() => () => {}),
  };
}

type Duplos = { ws: ReturnType<typeof wsFalso>; playback: ReturnType<typeof playbackFalso> };

function montar(duplos: Duplos, active = true) {
  const r = render(
    <RealtimeController
      ws={duplos.ws as unknown as SeraphineWS}
      playback={duplos.playback as unknown as PCMPlayback}
      active={active}
      onToggle={() => {}}
      manualMute={false}
      onManualMuteToggle={() => {}}
    />,
  );
  const repor = (a: boolean) => r.rerender(
    <RealtimeController
      ws={duplos.ws as unknown as SeraphineWS}
      playback={duplos.playback as unknown as PCMPlayback}
      active={a}
      onToggle={() => {}}
      manualMute={false}
      onManualMuteToggle={() => {}}
    />,
  );
  return { ...r, repor };
}

/** O boot do motor é assíncrono (VPIO -> fila do ORT -> VAD -> start). */
async function assentar(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await Promise.resolve(); });
  }
}

beforeEach(() => {
  h.ordem = [];
  h.cb = null;
  h.criouVad = 0;
  h.vpioCriadas = 0;
  h.vpioDisponivel = true;
  vi.mocked(createRealtimeVAD).mockClear();
  h.vadStart.mockReset().mockResolvedValue(undefined);
  h.vadStop.mockReset().mockImplementation(async () => { h.ordem.push('vad:stop'); });
  h.vadSuspende.mockReset();
  h.vadResume.mockReset();
  h.vpioStart.mockReset().mockResolvedValue(undefined);
  h.vpioStop.mockReset().mockImplementation(async () => { h.ordem.push('vpio:stop'); });
});

// Sem `restoreAllMocks` aqui de propósito: a limpeza automática do
// Testing Library desmonta o componente DEPOIS do teste, e agora esse desmonte
// desliga o motor de verdade. Apagar as implementações antes disso faria o
// próprio arreio estourar dentro do cleanup do React.

describe('RealtimeController · desligar o motor', () => {
  it('desmontar com a sessão LIGADA para o VAD e a sessão VPIO', async () => {
    const duplos = { ws: wsFalso(), playback: playbackFalso() };
    const { unmount } = montar(duplos, true);
    await assentar();

    // Pré-condição: o motor está de pé. Sem isto o teste passaria por vácuo.
    expect(h.criouVad).toBe(1);
    expect(h.vpioCriadas).toBe(1);
    expect(h.vpioStart).toHaveBeenCalledTimes(1);
    expect(h.vadStop).not.toHaveBeenCalled();
    expect(h.vpioStop).not.toHaveBeenCalled();

    unmount();
    await assentar();

    // O microfone e o audio unit: parados de verdade, não uma flag.
    expect(h.vadStop).toHaveBeenCalledTimes(1);
    expect(h.vpioStop).toHaveBeenCalledTimes(1);
  });

  it('desmontar solta o sink do VPIO ANTES de parar a sessão', async () => {
    const duplos = { ws: wsFalso(), playback: playbackFalso() };
    const { unmount } = montar(duplos, true);
    await assentar();
    expect(duplos.playback.setVpioSink).toHaveBeenCalledWith(
      expect.objectContaining({ stop: expect.anything() }),
    );

    unmount();
    await assentar();

    // A ordem importa: o sink tem que sair da playback antes de a sessão
    // morrer, senão o áudio não-realtime seguinte é empurrado para um audio
    // unit já parado em vez de cair de volta no Web Audio.
    const solta = h.ordem.indexOf('sink:null');
    const para = h.ordem.indexOf('vpio:stop');
    expect(solta).toBeGreaterThanOrEqual(0);
    expect(para).toBeGreaterThanOrEqual(0);
    expect(solta).toBeLessThan(para);
  });

  it('desmontar no meio de um turno avisa o backend em vez de largar a vez', async () => {
    const duplos = { ws: wsFalso(), playback: playbackFalso() };
    const { unmount } = montar(duplos, true);
    await assentar();

    // O usuário está falando: `audio_start` foi enviado e o turno está aberto.
    act(() => { h.cb?.onSpeechStart?.(); });
    await assentar();
    expect(duplos.ws.enviadas.map((m) => m.type)).toContain('audio_start');

    unmount();
    await assentar();

    // Este é o teste que pega o closure obsoleto: um cleanup que leia `state`
    // (e não `stateRef.current`) vê o 'idle' do primeiro render e cala tudo
    // isto — a playback seguiria tocando e o backend seguiria gerando a
    // resposta de uma vez que ninguém mais vai ouvir.
    const tipos = duplos.ws.enviadas.map((m) => m.type);
    expect(tipos).toContain('interrupt');
    expect(tipos).toContain('audio_end');
    expect(duplos.playback.stop).toHaveBeenCalled();
  });

  it('o `active` que cai continua desligando tudo, como antes', async () => {
    const duplos = { ws: wsFalso(), playback: playbackFalso() };
    const { repor } = montar(duplos, true);
    await assentar();

    act(() => { repor(false); });
    await assentar();

    expect(h.vadStop).toHaveBeenCalledTimes(1);
    expect(h.vpioStop).toHaveBeenCalledTimes(1);
    const solta = h.ordem.indexOf('sink:null');
    const para = h.ordem.indexOf('vpio:stop');
    expect(solta).toBeGreaterThanOrEqual(0);
    expect(solta).toBeLessThan(para);
  });

  it('desmontar com o boot AINDA EM VOO não deixa a sessão VPIO órfã', async () => {
    // A janela onde o `active` que cai nunca resolveu nada: o VPIO já subiu no
    // Rust mas ainda não foi publicado em ref nenhum. Quem desliga aqui é o
    // `cancelled` do boot, e o desligar do desmonte não pode parar a sessão uma
    // segunda vez nem seguir criando o VAD.
    let liberarStart: (() => void) | null = null;
    h.vpioStart.mockImplementation(() => new Promise<void>((res) => { liberarStart = res; }));

    const duplos = { ws: wsFalso(), playback: playbackFalso() };
    const { unmount } = montar(duplos, true);
    await assentar();
    expect(h.vpioCriadas).toBe(1);
    expect(h.criouVad).toBe(0);

    unmount();
    await act(async () => { liberarStart?.(); await Promise.resolve(); });
    await assentar();

    expect(h.vpioStop).toHaveBeenCalledTimes(1);
    // E nenhum VAD nasce depois do desmonte — seria um microfone sem dono.
    expect(h.criouVad).toBe(0);
  });

  it('um boot novo espera o stop do VAD anterior terminar', async () => {
    // O `vadStopPromiseRef` serializa os stops: o `stop()` precisa awaitar o
    // `session.release()` do ORT, e criar uma session nova antes disso corrompe
    // o WASM global ("Session already started" / "Out of bounds memory access").
    let liberar: (() => void) | null = null;
    h.vadStop.mockImplementation(() => new Promise<void>((res) => {
      h.ordem.push('vad:stop');
      liberar = res;
    }));

    const duplos = { ws: wsFalso(), playback: playbackFalso() };
    const { repor } = montar(duplos, true);
    await assentar();
    expect(h.criouVad).toBe(1);

    act(() => { repor(false); });
    await assentar();
    expect(h.vadStop).toHaveBeenCalledTimes(1);

    act(() => { repor(true); });
    await assentar();
    // O stop anterior ainda está em voo: o boot novo NÃO pode ter criado uma
    // session ORT nova.
    expect(h.criouVad).toBe(1);

    await act(async () => { liberar?.(); await Promise.resolve(); });
    await assentar();
    expect(h.criouVad).toBe(2);
  });
});
