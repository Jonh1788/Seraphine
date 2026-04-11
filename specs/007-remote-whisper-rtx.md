# Spec 007 — Remote Whisper STT service (RTX/Windows)

## Contexto

A Seraphine hoje transcreve voz com `mlx-community/whisper-small-mlx-q4` rodando
localmente no M4 Max via MLX. Funciona, mas o modelo é o `small` quantizado em
4-bit — o elo mais fraco do pipeline: nomes próprios, números, termos técnicos
e sotaques regionais vazam erros que fazem o LLM chamar a tool errada ou
entender o pedido pela metade.

Este spec define um **serviço HTTP standalone** que roda na máquina Windows
com GPU RTX (onde já mora o `Qwen3-TTS` em `192.168.15.6:8011/8013`) e expõe
transcrição via `whisper-large-v3-turbo`. A Seraphine passa a ter um
`RemoteWhisperSTT` adapter selecionável via env var e o local MLX fica como
fallback offline.

**Ganhos esperados:**
- WER em PT-BR **3–4× menor** (de ~10-12% para ~3-5% em áudio limpo; de
  ~18-22% para ~7-10% em áudio ruidoso)
- Latência ponta-a-ponta **similar ou melhor** (inferência GPU mais rápida
  compensa os ~10ms de LAN)
- Zero impacto no M4 Max (libera ~500 MB RAM quando o Whisper local era
  carregado em demanda)

## Objetivos

1. Serviço HTTP que aceita PCM raw, devolve transcrição em JSON
2. Modelo `whisper-large-v3-turbo` via `faster-whisper` (CTranslate2 + CUDA)
3. Warmup no boot (primeira inferência é offline → pré-aquece o grafo)
4. Health endpoint com estado do modelo + device
5. Instalável em Windows com passos reproduzíveis
6. Rodar em paralelo com Qwen3-TTS na mesma RTX sem brigar por VRAM
7. Exposto na LAN (bind `0.0.0.0`) pra o M4 Max alcançar via `192.168.15.6:8012`

## Não-objetivos (fora de escopo)

- Autenticação / tokens. A RTX está atrás de firewall LAN, confia no client.
- Streaming de transcrição parcial (partial transcripts mid-utterance).
  O client da Seraphine já corta em VAD-end e manda batch completo.
- Diarização, word-level timestamps, alinhamento.
- Multi-idioma automático. Forçamos `language="pt"` via body por default;
  cliente pode override.
- Múltiplos modelos carregados em memória ao mesmo tempo.

## Requisitos mínimos

### Hardware
- GPU NVIDIA com compute capability ≥ 7.0 (RTX 20xx ou superior)
- **VRAM livre ≥ 4 GB** durante a inferência. Whisper-large-v3-turbo em
  `float16` come ~3 GB. Como o Qwen3-TTS já usa parte da VRAM, conferir a
  sobra antes de habilitar. Se ficar justo, trocar `compute_type="float16"`
  por `"int8_float16"` → cai pra ~1.8 GB de VRAM com perda mínima de
  qualidade.
- Disco: ~2 GB livres para cache do modelo (`%USERPROFILE%\.cache\huggingface\hub\`)

### Software
- **Windows 10/11 64-bit**
- **NVIDIA Driver 535+** (recomendado 550+)
- **CUDA Toolkit 12.x** instalado e no PATH (`nvcc --version` deve funcionar)
- **cuDNN 9.x** compatível com a versão do CUDA
- **Python 3.11 ou 3.12** (faster-whisper ainda não tem wheels estáveis pra 3.13)
- `pip` ou `uv` pra gerenciar ambiente

### Dependências Python
```
faster-whisper==1.0.3     # CTranslate2 backend, GPU support
fastapi==0.115.0
uvicorn[standard]==0.30.6
numpy>=1.26,<2.0          # CT2 ainda não bate certo com numpy 2.x
pydantic>=2.5
```

## Stack e decisões

| Peça | Escolha | Porquê |
|---|---|---|
| Inference engine | `faster-whisper` (CTranslate2) | 3× mais rápido que `openai-whisper`, suporte CUDA nativo, memory-efficient |
| Modelo | `Systran/faster-whisper-large-v3-turbo` | Melhor qualidade/velocidade pra realtime, já convertido pra CT2 no Hub |
| Precisão computacional | `float16` (fallback `int8_float16`) | fp16 é ~2× mais rápido que int8_float16 e cabe bem em 4 GB |
| HTTP server | FastAPI + uvicorn | Mesma stack do backend da Seraphine, familiar |
| Formato de áudio | Raw PCM s16le mono (config. sample rate) | É o que o backend da Seraphine já envia, zero conversão |
| Porta | `8012` | Não colide com Qwen3-TTS (8011) nem o streaming (8013) |

## API Contract

### `POST /transcribe`

Transcreve um bloco de áudio PCM. Body é **raw bytes** (não multipart, não base64).

**Headers obrigatórios:**
- `Content-Type: audio/pcm` ou `application/octet-stream`
- `X-Sample-Rate: 16000` (o valor em Hz; aceitar 8000, 16000, 22050, 24000, 32000, 44100, 48000)

**Headers opcionais:**
- `X-Language: pt` (default `pt`; passar `auto` pra deixar o modelo detectar)
- `X-Beam-Size: 1` (default `1` pra velocidade; `5` pra mais acurácia)
- `X-VAD-Filter: true` (default `true` — pula silêncio usando VAD interno do faster-whisper)

**Request body:** bytes crus s16le mono no sample rate do header.

**Response 200** `application/json`:
```json
{
  "text": "oi seraphine cria uma task pra mim",
  "language": "pt",
  "language_probability": 0.98,
  "duration_seconds": 3.24,
  "inference_ms": 142,
  "segments": [
    {"start": 0.00, "end": 1.48, "text": "oi seraphine"},
    {"start": 1.48, "end": 3.24, "text": "cria uma task pra mim"}
  ]
}
```

**Erros:**
- `400` body vazio ou sample rate ausente/inválido
- `413` body > 25 MB (cap anti-abuso)
- `503` modelo ainda não carregou (dentro dos primeiros ~5s de boot)
- `500` falha de CUDA (com `detail` explicando)

### `GET /health`

Liveness + estado do modelo. Usado pelo bootstrap da Seraphine pra decidir
se sobe o backend com o adapter remoto ou cai no fallback local.

**Response 200:**
```json
{
  "status": "ok",
  "model": "large-v3-turbo",
  "device": "cuda",
  "compute_type": "float16",
  "warm": true,
  "vram_used_mb": 3072,
  "vram_total_mb": 12288,
  "uptime_s": 1234
}
```

- `warm: false` durante o carregamento inicial (primeiros ~10s)
- `status: "degraded"` se o modelo caiu pra CPU por falta de VRAM

## Implementação

### Estrutura de arquivos

```
whisper-rtx/
├── main.py              # FastAPI app, endpoints
├── transcriber.py       # WhisperModel singleton + warmup
├── config.py            # env vars
├── requirements.txt
├── README.md            # passos de instalação Windows
└── scripts/
    └── run.bat          # entry point com CUDA_VISIBLE_DEVICES etc.
```

### `transcriber.py` (coração do serviço)

```python
import numpy as np
import time
from faster_whisper import WhisperModel

class Transcriber:
    def __init__(self, model_name: str, device: str, compute_type: str):
        t0 = time.time()
        self.model = WhisperModel(
            model_name,
            device=device,
            compute_type=compute_type,
            num_workers=1,       # no multi-threaded workers — one request at a time
            cpu_threads=4,       # só relevante se cair pra CPU
        )
        self.loaded_at = time.time()
        self.load_seconds = self.loaded_at - t0
        self.warm = False

    def warmup(self):
        # roda uma transcrição dummy pra preencher caches e baixar pesos que
        # ainda estejam lazy. usa 1s de silêncio zerado.
        dummy = np.zeros(16000, dtype=np.float32)
        list(self.model.transcribe(
            dummy, language="pt", beam_size=1, vad_filter=True,
        )[0])
        self.warm = True

    def transcribe(self, pcm_bytes: bytes, sample_rate: int, *,
                   language: str = "pt", beam_size: int = 1,
                   vad_filter: bool = True):
        # s16le -> float32 mono normalizado [-1, 1]
        audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        if sample_rate != 16000:
            # faster-whisper espera 16k internamente. resample simples;
            # pra audio de mic é ok, se qualidade importar mais, usar librosa.
            audio = _resample_linear(audio, sample_rate, 16000)
        t0 = time.time()
        segments_iter, info = self.model.transcribe(
            audio,
            language=None if language == "auto" else language,
            beam_size=beam_size,
            vad_filter=vad_filter,
            vad_parameters={"min_silence_duration_ms": 300},
            condition_on_previous_text=False,  # evita drift em turnos curtos
        )
        segments = [
            {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
            for s in segments_iter
        ]
        return {
            "text": " ".join(s["text"] for s in segments).strip(),
            "language": info.language,
            "language_probability": round(info.language_probability, 3),
            "duration_seconds": round(info.duration, 2),
            "inference_ms": int((time.time() - t0) * 1000),
            "segments": segments,
        }
```

### `main.py`

- Carrega o `Transcriber` em `@app.on_event("startup")` (ou lifespan)
- Roda `warmup()` num `asyncio.create_task` pra não bloquear o bind
- `POST /transcribe` valida headers, chama `transcriber.transcribe(...)`
- `GET /health` expõe estado + query da VRAM via `pynvml` se disponível

### `config.py`

Todas as config lidas de env (defaults razoáveis):
```python
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "large-v3-turbo")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cuda")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "float16")
WHISPER_HOST = os.getenv("WHISPER_HOST", "0.0.0.0")
WHISPER_PORT = int(os.getenv("WHISPER_PORT", "8012"))
WHISPER_DEFAULT_LANGUAGE = os.getenv("WHISPER_DEFAULT_LANGUAGE", "pt")
MAX_BODY_MB = int(os.getenv("WHISPER_MAX_BODY_MB", "25"))
```

## Deploy no Windows

### Passo a passo

1. **Verificar CUDA:**
   ```bat
   nvidia-smi
   nvcc --version
   ```
   Ambos devem funcionar. Se `nvcc` não está no PATH, adicionar
   `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.x\bin` no
   `System Environment Variables > Path`.

2. **Criar venv:**
   ```bat
   cd C:\seraphine-services
   mkdir whisper-rtx
   cd whisper-rtx
   python -m venv .venv
   .venv\Scripts\activate
   pip install --upgrade pip
   ```

3. **Instalar deps:**
   ```bat
   pip install -r requirements.txt
   ```
   O `faster-whisper` puxa CTranslate2 que contém o runtime CUDA. Se der
   erro relacionado a cuDNN/cuBLAS faltando, seguir:
   https://github.com/SYSTRAN/faster-whisper?tab=readme-ov-file#gpu

4. **Testar localmente:**
   ```bat
   python main.py
   ```
   No primeiro run ele baixa os pesos do Hub (~1.6 GB). Depois do "warmup
   complete", testa:
   ```bat
   curl http://127.0.0.1:8012/health
   ```
   Deve devolver `"status": "ok"`, `"warm": true`, device `cuda`.

5. **Firewall:** Windows Defender → Advanced Settings → Inbound Rules → New
   Rule → Port → TCP 8012 → Allow. Nome "Seraphine Whisper STT".

6. **Startup automático (opcional):**
   Criar um `scripts\run.bat` que ativa o venv e roda `python main.py`. Colar
   atalho do `.bat` em `shell:startup` (Win+R `shell:startup`).

7. **Testar da LAN a partir do M4 Max:**
   ```bash
   curl http://192.168.15.6:8012/health
   ```
   Se não responder: firewall bloqueou OU o `main.py` não bindou em
   `0.0.0.0`.

## Warmup e carregamento

- Startup deve dar print claro em stdout:
  ```
  [whisper-rtx] loading model large-v3-turbo on cuda/float16...
  [whisper-rtx] model loaded in 4.2s
  [whisper-rtx] warming up (dummy transcription)...
  [whisper-rtx] warmup complete in 1.1s — ready on :8012
  ```
- Durante o carregamento, `/health` retorna `warm: false, status: "ok"`.
- Se o modelo falhar ao carregar no CUDA, log erro e **não cair pra CPU
  silenciosamente** — exit 1 com mensagem clara. CPU é 20× mais lento, não
  queremos isso passando despercebido.

## Critérios de aceite

Cada item testado antes de considerar o serviço pronto:

1. `GET /health` responde `{"status":"ok","warm":true,"device":"cuda"}` após
   ~10s do start.
2. `POST /transcribe` com 3 segundos de áudio PT-BR (frase simples como
   "oi Seraphine tudo bem") devolve:
   - `text` não-vazio e reconhecível (case-insensitive match contra o esperado)
   - `language: "pt"` com probability > 0.9
   - `duration_seconds` ≈ 3.0 (±0.1)
   - `inference_ms` < 250
3. `POST /transcribe` com 10 segundos de áudio devolve `inference_ms` < 800.
4. `POST /transcribe` com body de 5 requests concorrentes: todas retornam OK
   sem deadlock. Ordem de resposta livre.
5. Derruba e reinicia o serviço: `/health` volta a `warm:true` em < 15s
   (modelo já em cache de disco, só recarrega pesos).
6. `nvidia-smi` durante operação mostra VRAM estável (sem leak entre
   requests) e Qwen3-TTS ainda funcional na mesma GPU.
7. `curl` da LAN (do M4 Max) funciona na porta 8012.

## Integração com a Seraphine (do lado Mac)

Depois do serviço no ar, o backend da Seraphine ganha:

- `backend/seraphine/stt/remote.py` — `RemoteWhisperSTT` class implementando
  a mesma interface do `WhisperSTT` local (método `transcribe(pcm: bytes,
  sample_rate: int) -> Transcription`). Usa httpx pra `POST /transcribe`.
- `backend/seraphine/config.py` ganha:
  ```python
  stt_backend: str = "local"              # "local" | "remote"
  stt_remote_base_url: str = "http://192.168.15.6:8012"
  stt_remote_timeout: float = 10.0
  ```
- `backend/seraphine/main.py` no lifespan escolhe `WhisperSTT` ou
  `RemoteWhisperSTT` baseado em `settings.stt_backend`.
- `backend/seraphine/bootstrap.py` ganha `_check_remote_whisper()` que bate
  em `/health`; se não responder, **aborta o boot com mensagem clara** em
  vez de cair silenciosamente no local.

Isso é trabalho pra depois que o serviço RTX estiver funcionando.

## Validação fim-a-fim

Depois de ambos os lados prontos, o teste integrado:

1. Liga a Seraphine com `SERAPHINE_STT_BACKEND=remote` no `.env`
2. Bootstrap deve printar `✓ Remote whisper reachable at 192.168.15.6:8012`
3. No browser, usa push-to-talk: fala uma frase com nome próprio e número
   (ex: *"agenda reunião com Rodrigo dia 27 às 14 horas"*)
4. Compara a transcrição com o que seria o resultado do local
   `whisper-small-q4` — o remote deve acertar mais tokens, especialmente
   os nomes e números

## Riscos conhecidos

| Risco | Mitigação |
|---|---|
| VRAM da RTX cheia com Qwen3-TTS + Whisper | Começar com `float16`. Se crashar por OOM, cair pra `int8_float16` (~1.8 GB) |
| Latência de LAN alta (WiFi ruim) | Usar cabo se possível. Fallback: manter local como backup via env switch |
| Windows firewall bloqueando inbound | Regra explícita na porta 8012 no setup |
| Modelo não baixa por proxy corporativo | Documentar HF_HUB_OFFLINE / HTTP_PROXY env vars no README |
| CTranslate2 mudou ABI entre versões | Pinar versão exata (`==1.0.3`) em requirements.txt |
| Driver NVIDIA desatualizado | Exigir 535+ no README, printar erro claro se `torch.cuda.is_available()` falhar |

## Fora do escopo deste spec

- Métricas detalhadas (Prometheus). Só log plain pra começar.
- Auto-recuperação se CUDA crashar. Restart manual por enquanto.
- Load balancing / multi-GPU. Single RTX, single processo.
- Streaming bidirecional (websocket). Batch request/response só.
- Transcrição de arquivos MP3/WAV/FLAC. Só PCM raw. Se precisar, wrapper
  client-side.
