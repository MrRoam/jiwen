param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$outputDir = Join-Path $projectRoot 'output'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

$envFile = Join-Path $projectRoot '.env'
if (-not (Test-Path -LiteralPath $envFile)) { throw '未找到 .env，请先按 .env.example 配置转写和问答密钥。' }
$settings = @{}
foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') { $settings[$matches[1]] = $matches[2] }
}
function Get-Setting([string]$Name, $Default) {
    if ($settings.ContainsKey($Name) -and $settings[$Name] -ne '') { return $settings[$Name] }
    return $Default
}
function Test-Http([string]$Url) {
    try { return ((Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) } catch { return $false }
}
function Test-LocalConsole([int]$Port) {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/me" -UseBasicParsing -TimeoutSec 2
        return ($response.StatusCode -eq 200 -and ($response.Content | ConvertFrom-Json).console -eq $true)
    } catch { return $false }
}
function Get-ListenPid([int]$Port) {
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn) { return [int]$conn.OwningProcess }
    } catch {}
    return $null
}
function Stop-ProcessIfOwned([int]$ProcessId, [string[]]$Markers) {
    if (-not $ProcessId) { return }
    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
        if (-not $proc -or -not $proc.CommandLine) { return }
        $commandLine = $proc.CommandLine.Replace('\', '/')
        foreach ($marker in $Markers) {
            if ($commandLine.Contains($marker.Replace('\', '/'))) {
                Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
                Start-Sleep -Milliseconds 500
                return
            }
        }
    } catch {}
}
function Test-Classroom([string]$Url, [switch]$UseDoh) {
    # 本机代理可能把域名劫持成 fake-IP 导致握手失败，因此用 curl.exe 访问公网地址。
    # 首次直连失败时，再用 DoH 解析真实 IP 重试，绕过被劫持的本地 DNS。
    try {
        $oldPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $curlArgs = @('--silent', '--show-error', '--max-time', '10', '--fail-with-body')
            if ($UseDoh) { $curlArgs += @('--doh-url', 'https://1.1.1.1/dns-query') }
            $curlArgs += ($Url.TrimEnd('/') + '/api/me')
            $detail = (& curl.exe @curlArgs 2>&1 | ForEach-Object { $_.ToString() } | Out-String).Trim()
        } finally { $ErrorActionPreference = $oldPreference }
        if ($LASTEXITCODE -ne 0 -or -not $detail) { throw ('curl 退出码 ' + $LASTEXITCODE + '：' + $detail) }
        $body = $detail | ConvertFrom-Json
        if ($null -eq $body -or $null -eq $body.config -or
            $null -eq $body.config.asrReady) { throw '响应不是课堂服务的健康信息。' }
        $script:healthError = $null
        return $true
    } catch {
        $script:healthError = ($_.Exception.Message -replace "\r?\n", ' ')
        return $false
    }
}

$asrProvider = Get-Setting 'ASR_PROVIDER' 'remote'
$localAsrRecovery = (Get-Setting 'LOCAL_ASR_RECOVERY' 'false') -eq 'true'
$localAsrPort = [int](Get-Setting 'LOCAL_ASR_PORT' '4318')
$localAsrUrl = (Get-Setting 'LOCAL_ASR_URL' "http://127.0.0.1:$localAsrPort").TrimEnd('/')
$consolePort = [int](Get-Setting 'CONSOLE_PORT' '4319')

$oldAppPid = Get-ListenPid 4317
$reuseApp = $false
if ($oldAppPid) {
    $oldApp = Get-CimInstance Win32_Process -Filter "ProcessId=$oldAppPid"
    $expectedEntry = (Join-Path $projectRoot 'server/index.js').Replace('\', '/')
    if (-not $oldApp.CommandLine -or -not $oldApp.CommandLine.Replace('\', '/').Contains($expectedEntry) -or -not $oldApp.CommandLine.Contains('--production')) {
        throw ('端口 4317 已被其他程序占用（PID ' + $oldAppPid + '），请先关闭该程序。')
    }
    if (Test-Http 'http://127.0.0.1:4317/api/me') { $reuseApp = $true }
    else {
        Stop-ProcessIfOwned $oldAppPid @($expectedEntry)
        if (Get-ListenPid 4317) { throw '旧课堂服务未能停止，请检查端口 4317。' }
    }
}

if ($reuseApp) {
    $runningConfig = (Invoke-WebRequest -Uri 'http://127.0.0.1:4317/api/me' -UseBasicParsing -TimeoutSec 2).Content | ConvertFrom-Json
    if ($runningConfig.config.asrQuotaMode -ne 'trial') { throw '当前运行的是旧额度规则。请在无录音和处理任务时更新并重启，不能把复用旧服务当作一次性1小时体验已上线。' }
    # 健康的旧课堂实例可能尚未加载独立控制台，不能把“复用”当成升级成功。
    if ($consolePort -ne 0) {
        if (-not (Test-LocalConsole $consolePort)) { throw '课堂服务已在运行，但本机控制台尚未加载。重新运行启动脚本不会更新旧服务；请结束当前任务后停止内测，再重新启动。' }
    }
    Write-Host '[1/4] 课堂服务已在运行，保留现有录音与页面。'
}
else {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '需要 Node.js 24 或更新版本。' }
    if ([int](& node -p 'parseInt(process.versions.node)') -lt 24) { throw '需要 Node.js 24 或更新版本。' }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw '未找到 npm.cmd。' }
    if (-not (Test-Path -LiteralPath 'node_modules/.bin/vite.cmd')) {
        npm.cmd ci --include=dev
        if ($LASTEXITCODE -ne 0) { throw '安装依赖失败。' }
    }
    Write-Host '[1/4] 正在构建网页……'
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw '网站构建失败。' }
}

# 本地实时转写或本机后台补转写启用时，按配置启动 Python。
$started = @()
$publicReady = $false
try {
$startedLocalAsr = $false
if ($asrProvider -eq 'local' -or $localAsrRecovery) {
    # Python不会读取.env，显式传递本机模型运行参数。
    foreach ($asrSetting in @('LOCAL_ASR_ENGINE','LOCAL_ASR_DEVICE','LOCAL_ASR_MODEL','LOCAL_ASR_MODEL_PATH','LOCAL_ASR_COMPUTE','LOCAL_ASR_MAX_STREAMS','LOCAL_ASR_QUEUE_SIZE','LOCAL_ASR_PORT')) {
        if ($settings.ContainsKey($asrSetting)) { [Environment]::SetEnvironmentVariable($asrSetting, $settings[$asrSetting], 'Process') }
    }
    $pythonExe = Join-Path $projectRoot '.venv-asr\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $pythonExe)) { throw '已启用本地实时转写或后台补转写，但未找到 .venv-asr。请先按 README 安装本地转写环境。' }
    if (-not (Test-Http ($localAsrUrl + '/health'))) {
        $localAsrEntry = Join-Path $projectRoot 'server\local_asr.py'
        $p = Start-Process -FilePath $pythonExe -ArgumentList $localAsrEntry -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $outputDir 'local-asr.log') -RedirectStandardError (Join-Path $outputDir 'local-asr-error.log')
        $started += $p; $startedLocalAsr = $true
        $ready = $false
        for ($i = 0; $i -lt 120; $i++) {
            if ($p.HasExited) { throw '本地转写启动失败，请查看 output\local-asr-error.log。' }
            if (Test-Http ($localAsrUrl + '/health')) { $ready = $true; break }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) { throw '本地转写未能按时启动，请查看 output\local-asr-error.log。' }
    }
}

$appProcess = $null
Write-Host '[2/4] 正在启动课堂服务……'
$env:HOST = '127.0.0.1'
$env:PORT = '4317'
$env:SECURE_COOKIE = 'true'
$env:API_CONFIG_ENABLED = 'false'
$env:ASR_QUOTA_MODE = 'trial'
$appEntry = Join-Path $projectRoot 'server\start.js'
if ($reuseApp) { $appProcess = Get-Process -Id $oldAppPid }
else {
    $appProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList '--env-file=.env', $appEntry, '--production' -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $outputDir 'trial-server.log') -RedirectStandardError (Join-Path $outputDir 'trial-server-error.log')
    $started += $appProcess
}
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
    if ($appProcess.HasExited) { throw '课堂服务启动失败，请查看 output\trial-server-error.log。' }
    if (Test-Http 'http://127.0.0.1:4317/api/me') { $ready = $true; break }
    Start-Sleep -Milliseconds 250
}
if (-not $ready) { throw '课堂服务未能按时启动，请查看 output\trial-server-error.log。' }
if ($consolePort -ne 0 -and -not (Test-LocalConsole $consolePort)) { throw '本机控制台未就绪，请查看 output\trial-server-error.log。' }

# Cloudflare Tunnel 由 Windows 服务（cloudflared）常驻运行，脚本只检查其状态。
Write-Host '[3/4] 正在检查 Cloudflare Tunnel……'
$publicUrl = (Get-Setting 'TRIAL_PUBLIC_URL' 'https://jiwen.yaojiaxu.com').TrimEnd('/')
$tunnelService = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
if (-not $tunnelService) { throw '未找到 cloudflared 服务。请先按 Cloudflare 文档把 Tunnel 安装并注册为 Windows 服务。' }
if ($tunnelService.Status -ne 'Running') {
    Write-Host 'cloudflared 服务未在运行，正在尝试启动（可能需要管理员权限）……'
    try { Start-Service -Name 'cloudflared' -ErrorAction Stop } catch { throw ('无法启动 cloudflared 服务：' + $_.Exception.Message + '。请以管理员身份运行本脚本，或在“服务”管理器中手动启动。') }
    Start-Sleep -Seconds 2
}
if ((Get-Service -Name 'cloudflared').Status -ne 'Running') { throw 'cloudflared 服务未在运行，请在“服务”管理器中启动后重试。' }

# 通过 cloudflared 的本机状态接口确认隧道已连上 Cloudflare 边缘。
$tunnelReady = $false
$tunnelError = '未找到 cloudflared 的本机状态接口。'
$tunnelPids = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Select-Object -ExpandProperty ProcessId)
foreach ($tunnelPid in $tunnelPids) {
    foreach ($listen in (Get-NetTCPConnection -State Listen -OwningProcess $tunnelPid -ErrorAction SilentlyContinue | Sort-Object LocalPort -Unique)) {
        try {
            $response = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $listen.LocalPort + '/ready') -UseBasicParsing -TimeoutSec 2
            $state = $response.Content | ConvertFrom-Json
            if ($state.status -eq 200 -and $state.readyConnections -ge 1) { $tunnelReady = $true; break }
        } catch { $tunnelError = $_.Exception.Message }
    }
    if ($tunnelReady) { break }
}
if (-not $tunnelReady) { throw ('Cloudflare Tunnel 尚未连接到边缘节点（' + $tunnelError + '）。请稍后重试，或在“服务”管理器中重启 cloudflared。') }

$publicReady = $false
Write-Host ('[4/4] 正在验证公网 HTTPS：' + $publicUrl)
for ($i = 0; $i -lt 20; $i++) {
    if (Test-Classroom $publicUrl) { $publicReady = $true; break }
    if (Test-Classroom $publicUrl -UseDoh) { $publicReady = $true; break }
    if ($i % 5 -eq 0) { Write-Host ('公网尚未就绪，正在重试：' + $script:healthError) }
    Start-Sleep -Seconds 1
}
if (-not $publicReady) {
    throw ('公网 HTTPS 无法访问课堂服务：' + $publicUrl + '；' + $script:healthError + '。请检查 Cloudflare Tunnel 的公共主机名是否指向 http://localhost:4317，以及本机代理是否放行该域名。')
}

$clipboardCopied = $false
try {
    Set-Clipboard -Value $publicUrl -ErrorAction Stop
    $clipboardCopied = $true
} catch {}
Write-Host ''
Write-Host ('内测地址：' + $publicUrl)
if ($clipboardCopied) { Write-Host '地址已复制到剪贴板。' }
else { Write-Warning '地址已生成，但复制到剪贴板失败，请手动复制上方地址。' }
if (-not $NoBrowser) { Start-Process $publicUrl }
Write-Host ''
Write-Host '课堂服务已在后台运行；关闭此窗口不会停止服务。需要停止时运行 deploy/stop-trial.ps1。'
Write-Host ('本地日志：' + $outputDir)
    while ($true) {
        Start-Sleep -Seconds 5
        if ($appProcess.HasExited) { throw '课堂服务已退出。' }
        $tunnelStatus = (Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue).Status
        if ($tunnelStatus -and $tunnelStatus -ne 'Running') { throw 'cloudflared 服务已停止，公网无法访问。' }
        if (-not (Test-Http 'http://127.0.0.1:4317/api/me')) { throw '课堂服务健康检查失败。' }
    }
} catch {
    Write-Host ('内测启动或运行失败：' + $_.Exception.Message) -ForegroundColor Red
    if (-not $publicReady) {
        foreach ($p in $started) {
            if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
        }
    }
    throw
}
