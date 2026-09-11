param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repoRoot 'data\windows\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Test-ServiceUrl([string]$Url) {
    try {
        $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        return $true
    } catch { return $false }
}

function Wait-ServiceUrl([string]$Url, [int]$Seconds = 120) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-ServiceUrl $Url) { return }
        Start-Sleep -Milliseconds 500
    }
    throw "O servico em $Url nao iniciou. Consulte $logDir."
}

function Start-Helper([string]$Name, [string]$File, [string]$Arguments, [string]$Directory) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $Directory `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logDir "$Name.out.log") `
        -RedirectStandardError (Join-Path $logDir "$Name.err.log")
    $process.Id | Set-Content -LiteralPath (Join-Path $logDir "..\$Name.pid")
}

try {
    $python = Join-Path $repoRoot '.venv\Scripts\python.exe'
    $frontend = Join-Path $repoRoot 'apps\seraphine\frontend'
    $backend = Join-Path $repoRoot 'apps\seraphine\backend'
    $ollama = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    foreach ($required in @($python, $ollama, (Join-Path $frontend 'dist\index.html'), (Join-Path $backend '.env'))) {
        if (-not (Test-Path -LiteralPath $required)) { throw "Arquivo necessario ausente: $required. Consulte docs/windows.md." }
    }

    if (-not (Test-ServiceUrl 'http://127.0.0.1:11434/api/tags')) {
        $env:OLLAMA_HOST = '127.0.0.1:11434'
        $env:OLLAMA_CONTEXT_LENGTH = '32768'
        $env:OLLAMA_FLASH_ATTENTION = '1'
        $env:OLLAMA_KV_CACHE_TYPE = 'q8_0'
        $env:OLLAMA_NUM_PARALLEL = '1'
        Start-Helper 'ollama' $ollama 'serve' $repoRoot
        Wait-ServiceUrl 'http://127.0.0.1:11434/api/tags' 30
    }

    # Read the same settings as the backend without evaluating .env as shell code.
    Push-Location $backend
    try {
        $ttsBackend = (& $python -c 'from seraphine.config import settings; print(settings.tts_backend)').Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel ler a configuracao de voz.' }
    } finally { Pop-Location }

    # ElevenLabs needs no local voice server.
    if ($ttsBackend -eq 'qwen3' -and -not (Test-ServiceUrl 'http://127.0.0.1:8011/health')) {
        $voiceScript = Join-Path (Split-Path -Parent $repoRoot) 'qwen3-tts-server\start-qwen3-tts-triton-server.sh'
        if (-not (Test-Path -LiteralPath $voiceScript)) { throw "Servidor de voz nao encontrado: $voiceScript" }
        $wslPath = (& wsl.exe -d Ubuntu -u root --exec wslpath -a $voiceScript.Replace('\', '/')).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel iniciar o Ubuntu no WSL.' }
        Start-Helper 'tts' 'wsl.exe' "-d Ubuntu -u root -- bash `"$wslPath`"" $repoRoot
        Wait-ServiceUrl 'http://127.0.0.1:8011/health' 120
    }

    if (Test-Path -LiteralPath (Join-Path $repoRoot 'data\windows\migrated-services.ready')) {
        & (Join-Path $PSScriptRoot 'start-windows-services.ps1')
    }

    if (-not (Test-ServiceUrl 'http://127.0.0.1:8000/health')) {
        $env:ANONYMIZED_TELEMETRY = 'false'
        $env:PYTHONUTF8 = '1'
        Start-Helper 'backend' $python '-m uvicorn seraphine.main:app --env-file .env --host 127.0.0.1 --port 8000' $backend
        Wait-ServiceUrl 'http://127.0.0.1:8000/health' 180
    }
    if (-not (Test-ServiceUrl 'http://127.0.0.1:5173/')) {
        Start-Helper 'frontend' $node 'node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5173 --strictPort' $frontend
        Wait-ServiceUrl 'http://127.0.0.1:5173/' 30
    }

    if (-not $NoBrowser) {
        $edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
        if (Test-Path -LiteralPath $edge) {
            # This is the interactive application window requested by the user.
            Start-Process -FilePath $edge -ArgumentList '--app=http://127.0.0.1:5173 --new-window'
        } else { Start-Process 'http://127.0.0.1:5173/' }
    }
    Write-Output 'Seraphine pronta em http://127.0.0.1:5173/'
} catch {
    $_ | Out-String | Set-Content -LiteralPath (Join-Path $logDir 'startup-error.log')
    if (-not $NoBrowser) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Seraphine') | Out-Null
    }
    throw
}
