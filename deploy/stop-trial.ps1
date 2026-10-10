$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$markers = @(
    (Join-Path $projectRoot 'server/start.js'),
    (Join-Path $projectRoot 'server/index.js'),
    (Join-Path $projectRoot 'server\local_asr.py'),
    (Join-Path $projectRoot 'server/local_asr.py')
)
$stopped = 0
foreach ($process in Get-CimInstance Win32_Process) {
    if (-not $process.CommandLine) { continue }
    $commandLine = $process.CommandLine.Replace('\', '/')
    foreach ($marker in $markers) {
        if ($commandLine.Contains($marker.Replace('\', '/'))) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
            $stopped++
            break
        }
    }
}
# Cloudflare Tunnel 是常驻 Windows 服务，保持运行以便随时恢复内测；如需彻底断开公网，注释下一行。
$tunnelService = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
if ($tunnelService -and $tunnelService.Status -eq 'Running') {
    Write-Host '提示：cloudflared 服务仍在运行，公网入口保持可用。如需停止公网访问，请在“服务”管理器中停止 cloudflared。'
}
Write-Host ('已停止 ' + $stopped + ' 个相关进程。')
