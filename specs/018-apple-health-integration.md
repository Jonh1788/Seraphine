# 018 — Integração Apple Health (HealthKit)

## Context

Seraphine roda no macOS 13+ com Tauri. O HealthKit está disponível no macOS
e sincroniza dados do iPhone e Apple Watch automaticamente. Acessar esses
dados permite que Seraphine ofereça insights de saúde, integre com hábitos,
e dê contexto de bem-estar na conversa.

## Viabilidade Técnica

### HealthKit no macOS
- Disponível desde macOS 13.0 (nosso mínimo)
- Framework: `HealthKit.framework`
- Acesso: leitura (escrita limitada no macOS)
- Dados sincronizados via iCloud do iPhone/Apple Watch
- Requer entitlement: `com.apple.developer.healthkit`
- Requer permissão do usuário no primeiro acesso

### Acesso via Tauri
- Tauri 2 suporta plugins nativos em Swift via `tauri-plugin-swift`
- O plugin Swift chama HealthKit APIs e retorna JSON pro frontend
- Alternativa: Rust FFI para Objective-C (mais complexo)

## Escopo

### 018-A: Tauri Swift Plugin — HealthKit Bridge

**Plugin:** `tauri-plugin-healthkit`

```swift
// Plugin commands expostos ao frontend:
@Command
func requestAuthorization() -> Bool
// Solicita permissão de leitura para os tipos de dados

@Command
func getSteps(startDate: String, endDate: String) -> [StepSample]
// Passos por dia no intervalo

@Command
func getSleep(startDate: String, endDate: String) -> [SleepSample]
// Sessões de sono (asleep, inBed, REM, deep, core)

@Command
func getHeartRate(startDate: String, endDate: String) -> [HeartRateSample]
// BPM com timestamps

@Command
func getWorkouts(startDate: String, endDate: String) -> [WorkoutSample]
// Treinos (tipo, duração, calorias, distância)

@Command
func getWeight(startDate: String, endDate: String) -> [WeightSample]
// Peso corporal

@Command
func getActiveEnergy(startDate: String, endDate: String) -> [EnergySample]
// Calorias ativas queimadas

@Command
func getTodaySummary() -> HealthSummary
// Resumo agregado do dia: passos, calorias, treinos, sono última noite
```

**Tipos de retorno:**
```typescript
interface StepSample {
  date: string;      // YYYY-MM-DD
  count: number;
}

interface SleepSample {
  start: string;     // ISO
  end: string;       // ISO
  stage: 'asleep' | 'inBed' | 'rem' | 'deep' | 'core' | 'awake';
  duration_min: number;
}

interface HeartRateSample {
  timestamp: string;
  bpm: number;
}

interface WorkoutSample {
  type: string;      // 'running', 'walking', 'cycling', 'strength', etc.
  start: string;
  end: string;
  duration_min: number;
  calories: number;
  distance_km?: number;
}

interface HealthSummary {
  steps: number;
  active_calories: number;
  workouts_today: number;
  workout_minutes: number;
  resting_heart_rate?: number;
  sleep_hours?: number;    // última noite
  sleep_quality?: string;  // 'boa', 'regular', 'ruim' (baseado em deep/REM %)
  weight_kg?: number;      // último registro
}
```

### 018-B: Backend Health Service

```python
# seraphine/health/service.py

class HealthService:
    """Proxy para dados do HealthKit via Tauri IPC.
    
    No backend, os dados chegam via WebSocket do frontend
    (o plugin Tauri roda no frontend, não no backend).
    Alternativa: o frontend chama o plugin e envia pro backend
    via HTTP/WS quando solicitado.
    """

    async def get_today_summary(self) -> HealthSummary:
        """Chamado pelo LLM tool. Frontend faz bridge."""

    async def get_weekly_report(self) -> WeeklyHealthReport:
        """Agregação de 7 dias: médias, tendências."""
```

**Arquitetura de dados:**
```
HealthKit (macOS) → Swift Plugin → Tauri IPC → Frontend JS
  → WebSocket → Backend Python → LLM Tool → Chat response
```

Alternativa mais simples:
```
HealthKit → Swift Plugin → Frontend JS → renders directly
                                        → stores in SQLite via API
```

### 018-C: LLM Tools

```python
class HealthSummaryTool(Tool):
    name = "health_summary"
    description = (
        "Get the user's health data from Apple Health. Shows today's "
        "steps, calories, workouts, sleep, and heart rate. Use when "
        "the user asks about their health, exercise, sleep, or fitness."
    )
    # Returns rich card with health stats

class HealthTrendTool(Tool):
    name = "health_trend"
    description = (
        "Analyze health trends over a period. Shows patterns in steps, "
        "sleep quality, workout frequency, and weight changes."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "metric": {
                "type": "string",
                "enum": ["steps", "sleep", "workouts", "weight", "heart_rate"],
            },
            "days": { "type": "integer", "description": "Number of days to analyze" },
        },
    }
```

### 018-D: Health Chat Card

```
┌──────────────────────────────────────┐
│  ❤️‍🔥  Saúde Hoje                     │
├──────────────────────────────────────┤
│  🦶 Passos      8.432 / 10.000      │
│  ████████░░                          │
│                                      │
│  🔥 Calorias    423 kcal             │
│  😴 Sono        7h 12min (boa)       │
│  💪 Treinos     1 (corrida, 32min)   │
│  ❤️ FC Repouso  62 bpm               │
└──────────────────────────────────────┘
```

**Implementação:** React component `HealthChatBlock.tsx` com SVG icons,
progress bars, e cores semânticas (verde = meta atingida, amber = parcial,
vermelho = abaixo).

### 018-E: Dashboard Integration

Widget no dashboard (spec 012):
```
┌─────────────────────┐
│  Saúde              │
│  8.432 passos       │
│  7h sono            │
│  1 treino           │
└─────────────────────┘
```

### 018-F: Habits Integration

Sync automático com hábitos (spec 014):
- Hábito "Exercício" → auto-completa quando HealthKit registra treino
- Hábito "Sono 8h" → auto-completa quando sleep ≥ 8h
- Hábito "10k passos" → auto-completa quando steps ≥ 10000

### 018-G: Insights Integration

Análise proativa (spec 015):
- "Seu sono caiu 1.5h esta semana comparado à anterior"
- "Você caminhou 30% menos nos últimos 3 dias"
- "Sua FC de repouso subiu 8bpm — pode indicar cansaço acumulado"
- "Parabéns! 7 dias seguidos atingindo meta de passos"

## Entitlements & Permissões

### Tauri config
```json
// src-tauri/tauri.conf.json
{
  "bundle": {
    "macOS": {
      "entitlements": "./Entitlements.plist"
    }
  }
}
```

### Entitlements.plist
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.developer.healthkit</key>
  <true/>
  <key>com.apple.developer.healthkit.access</key>
  <array>
    <string>health-records</string>
  </array>
</dict>
</plist>
```

### Info.plist additions
```xml
<key>NSHealthShareUsageDescription</key>
<string>Seraphine usa dados do Apple Saúde para mostrar resumos de
atividade, sono e saúde na sua assistente pessoal.</string>
<key>NSHealthUpdateUsageDescription</key>
<string>Seraphine pode registrar dados de hábitos no Apple Saúde.</string>
```

## Requisitos

- macOS 13.0+ (já é o mínimo)
- iPhone/Apple Watch sincronizado via iCloud (pra ter dados)
- Permissão do usuário no primeiro acesso
- Apple Developer account (pra entitlement de HealthKit)

## Dependências

- Tauri 2 Swift plugin system
- 012 Dashboard (widget)
- 014 Hábitos (auto-complete)
- 015 Insights (análise de padrões)

## Fora de escopo

- Escrita no HealthKit (apenas leitura inicialmente)
- Dados de ECG, oxímetro, temperatura (muito específicos)
- Integração com apps de terceiros (MyFitnessPal, Strava)
- Recomendações médicas (liability)
