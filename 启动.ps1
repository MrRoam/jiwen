$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '请先安装 Node.js 24 或更新版本。' }
if ([int](& node -p 'parseInt(process.versions.node)') -lt 24) { throw '请先升级到 Node.js 24 或更新版本。' }
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw '未找到 npm，请重新安装包含 npm 的 Node.js 24 或更新版本。' }
Write-Host '正在同步项目依赖（包含页面构建所需的 Vite）...'
npm.cmd install --include=dev
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请查看上方 npm 错误，处理后重新启动。' }
if (-not (Test-Path -LiteralPath 'node_modules/.bin/vite.cmd')) { throw '未生成 Vite 启动文件，请运行 npm.cmd install --include=dev --bin-links=true 后重试。' }
$port = & node --env-file-if-exists=.env -p 'Number(process.env.PORT || 4317)'
if ($LASTEXITCODE -ne 0 -or $port -notmatch '^\d+$' -or [int]$port -lt 1 -or [int]$port -gt 65535) { throw '请检查 .env 中的 PORT 配置。' }
if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw "端口 $port 已被占用。如果网站已在运行，请打开 http://localhost:$port；修改密钥后需要先关闭旧服务再启动。" }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw '页面构建失败。' }
$url = "http://localhost:$port"
Write-Host "正在启动即问，浏览器将自动打开 $url"
Write-Host '使用期间请保留此窗口；关闭窗口或按 Ctrl+C 可停止服务。'
$browserJob = Start-Job -ArgumentList $url -ScriptBlock {
    param($address)
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $address -UseBasicParsing -TimeoutSec 1
            if ($response.StatusCode -eq 200) { Start-Process $address; break }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
}
try {
    npm.cmd start
    if ($LASTEXITCODE -ne 0) { throw '服务启动失败，请查看上方错误信息。' }
} finally {
    Stop-Job $browserJob -ErrorAction SilentlyContinue
    Remove-Job $browserJob -Force -ErrorAction SilentlyContinue
}

