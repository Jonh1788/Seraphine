param([switch]$ProxyOnly)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$compose = Join-Path $repoRoot 'apps\seraphine\docker-compose.windows.yml'
$keeperState = Join-Path $repoRoot 'data\windows\wsl-keeper.pid'
$keeper = $null
if (Test-Path -LiteralPath $keeperState) {
    $keeperId = (Get-Content -Raw -LiteralPath $keeperState).Trim()
    if ($keeperId -match '^\d+$') {
        $keeper = Get-CimInstance Win32_Process -Filter "ProcessId=$keeperId" -ErrorAction SilentlyContinue
    }
}
# systemd services alone do not keep a WSL distribution running.
if (-not $keeper -or $keeper.CommandLine -notlike '*sleep infinity*') {
    $keeper = Start-Process -FilePath 'wsl.exe' -ArgumentList '-d Ubuntu -u root --exec /usr/bin/sleep infinity' -WindowStyle Hidden -PassThru
    $keeper.Id | Set-Content -LiteralPath $keeperState
}
& wsl.exe -d Ubuntu -u root --exec systemctl start docker
if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel iniciar os servicos no Ubuntu.' }
$route = (& wsl.exe -d Ubuntu -u root --exec ip -4 route show default) -join ' '
$gateway = ($route -split '\s+')[2]
$wslAddress = ((& wsl.exe -d Ubuntu -u root --exec hostname -I) -split '\s+')[0]
$null = [System.Net.IPAddress]::Parse($gateway)
$null = [System.Net.IPAddress]::Parse($wslAddress)
if (-not (Get-NetIPAddress -IPAddress $gateway -ErrorAction SilentlyContinue)) {
    throw 'Nao foi possivel identificar a rede local do Ubuntu.'
}

# A user-level relay keeps the app usable without administrator privileges.
$networkScript = Join-Path $PSScriptRoot 'windows_network.py'
$networkState = Join-Path $repoRoot 'data\windows\network.json'
$running = $false
if (Test-Path -LiteralPath $networkState) {
    $state = Get-Content -Raw -LiteralPath $networkState | ConvertFrom-Json
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.pid)" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -like "*$networkScript*") {
        $running = $state.wsl -eq $wslAddress -and $state.gateway -eq $gateway
        if (-not $running) {
            Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $state.pid -and $_.CommandLine -like "*$networkScript*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
            Stop-Process -Id $state.pid -Force
        }
    }
}
if (-not $running) {
    $venvPython = Join-Path $repoRoot '.venv\Scripts\python.exe'
    $python = (& $venvPython -c 'import sys; print(sys._base_executable)').Trim()
    $logDir = Join-Path $repoRoot 'data\windows\logs'
    $process = Start-Process -FilePath $python -ArgumentList "`"$networkScript`" $wslAddress $gateway" `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'network.out.log') `
        -RedirectStandardError (Join-Path $logDir 'network.err.log')
    @{ pid = $process.Id; wsl = $wslAddress; gateway = $gateway } | ConvertTo-Json | Set-Content -LiteralPath $networkState
}
$wslCompose = (& wsl.exe -d Ubuntu -u root --exec wslpath -a $compose.Replace('\', '/')).Trim()
if ($ProxyOnly) {
    & wsl.exe -d Ubuntu -u root --exec env "SERAPHINE_WINDOWS_HOST=$gateway" /usr/bin/docker compose -f $wslCompose up -d cliproxy
} else {
    & wsl.exe -d Ubuntu -u root --exec env "SERAPHINE_WINDOWS_HOST=$gateway" /usr/bin/docker compose -f $wslCompose up -d
}
if ($LASTEXITCODE -ne 0) { throw 'Os servicos migrados nao iniciaram. Consulte os logs do Docker no Ubuntu.' }
