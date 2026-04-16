# 020 — Native Audio Capture (Tauri Plugin)

## Context

WKWebView (macOS Tauri runtime) não expõe `navigator.mediaDevices.getUserMedia`,
então gravação de microfone via browser API não funciona em builds desktop.
Precisamos de captura nativa via Rust + CoreAudio (macOS) ou equivalente.

Isso permite o microfone funcionar em qualquer janela Tauri (main, companion,
quick-capture) sem depender do WebView.

## Estratégia

- Plugin Rust custom dentro do `src-tauri/src/` usa crate `cpal` (multiplataforma)
- Comandos Tauri expostos ao frontend: `start_mic_capture`, `stop_mic_capture`
- PCM chunks streamados via Tauri events (`mic-pcm-chunk`)
- Frontend wrapper: `src/audio/tauriMic.ts` que expõe mesma interface que `MicCapture`
- `MicCapture` tenta Tauri primeiro, cai pro Web API se não disponível

## Implementação

### Backend Rust

**`Cargo.toml`:**
```toml
cpal = "0.15"
crossbeam-channel = "0.5"
```

**`src/mic.rs`:**
```rust
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tauri::{AppHandle, Emitter, State};

struct MicState {
    stream: Mutex<Option<cpal::Stream>>,
}

#[tauri::command]
fn start_mic_capture(app: AppHandle, state: State<MicState>) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or("No input device")?;
    let config = device.default_input_config().map_err(|e| e.to_string())?;
    
    let sample_rate = config.sample_rate().0;
    let channels = config.channels();
    
    let app_handle = app.clone();
    let stream = device.build_input_stream(
        &config.into(),
        move |data: &[f32], _| {
            // Downsample to 16kHz mono, convert to i16 PCM
            let pcm = process_audio(data, sample_rate, channels);
            // Emit as event
            let _ = app_handle.emit("mic-pcm-chunk", pcm);
        },
        |err| eprintln!("Mic error: {}", err),
        None,
    ).map_err(|e| e.to_string())?;
    
    stream.play().map_err(|e| e.to_string())?;
    *state.stream.lock().unwrap() = Some(stream);
    Ok(())
}

#[tauri::command]
fn stop_mic_capture(state: State<MicState>) -> Result<(), String> {
    *state.stream.lock().unwrap() = None; // drops stream
    Ok(())
}
```

**`lib.rs`:**
- Register `MicState` via `.manage()`
- Add commands to `.invoke_handler(tauri::generate_handler![...])`

**`Info.plist`:**
- Adicionar `NSMicrophoneUsageDescription` via `tauri.conf.json > bundle.macOS.infoPlist`

### Frontend

**`src/audio/tauriMic.ts`:**
```typescript
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export class TauriMicCapture {
  private listeners = new Set<(pcm: Int16Array) => void>();
  private unlisten: (() => void) | null = null;

  async start(): Promise<void> {
    this.unlisten = await listen<number[]>('mic-pcm-chunk', (event) => {
      const pcm = new Int16Array(event.payload);
      this.listeners.forEach((cb) => cb(pcm));
    });
    await invoke('start_mic_capture');
  }

  async stop(): Promise<void> {
    await invoke('stop_mic_capture');
    this.unlisten?.();
    this.unlisten = null;
  }

  onChunk(cb: (pcm: Int16Array) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

export async function isTauriMicAvailable(): Promise<boolean> {
  try {
    await import('@tauri-apps/api/core');
    return typeof (window as any).__TAURI_INTERNALS__ !== 'undefined';
  } catch {
    return false;
  }
}
```

**`src/audio/micCapture.ts`** (modificado):
- Na construção, detecta se Tauri está disponível
- Se sim, usa `TauriMicCapture` internamente
- Se não, usa Web API existente
- Interface pública idêntica — zero mudança nos callers

### Capability

Adicionar em `capabilities/default.json`:
```json
"mic:start_mic_capture",
"mic:stop_mic_capture"
```

## Fora de escopo

- VAD nativo (continua no frontend via ONNX web)
- Controle de input device (usa default)
- Resampling de alta qualidade (linear é suficiente pra voz)
