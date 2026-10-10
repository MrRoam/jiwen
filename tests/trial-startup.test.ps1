$ErrorActionPreference = 'Stop'
$path = Join-Path $PSScriptRoot '../deploy/start-trial.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
# 启动失败清理刚创建的进程；启动成功后关闭窗口不能停止课堂服务。
$outerTry = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.TryStatementAst] -and $node.Body.Extent.Text.Contains('$appProcess = Start-Process') }, $true)
if (-not $outerTry -or -not $outerTry.CatchClauses[0].Extent.Text.Contains('if (-not $publicReady)')) { throw '启动失败时必须清理本次创建的服务。' }
if ($outerTry.Finally -and $outerTry.Finally.Extent.Text.Contains('Stop-Process')) { throw '关闭启动窗口不能停止已就绪的课堂服务。' }
# 公网地址必须来自 .env 配置，不能在脚本里随意硬编码其他来源。
if ($outerTry.Body.Extent.Text -notmatch [regex]::Escape("Get-Setting 'TRIAL_PUBLIC_URL'")) { throw '公网地址应通过 .env 的 TRIAL_PUBLIC_URL 配置。' }
# 健康检查应支持 DoH 回退，以绕过本机代理对域名的劫持。
$bodyText = $ast.Extent.Text
if ($bodyText -notmatch [regex]::Escape("`$env:API_CONFIG_ENABLED = 'false'")) { throw '内测试用站应关闭页面 API 配置。' }
if ($bodyText -notmatch [regex]::Escape("`$env:ASR_QUOTA_MODE = 'trial'")) { throw '体验站必须启用一次性1小时额度。' }
if ($bodyText -notmatch '--doh-url') { throw '健康检查应支持 DoH 解析回退。' }

# 载入健康检查函数并用模拟 curl 验证判定逻辑。
$healthDefinition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-Classroom' }, $true)
Invoke-Expression $healthDefinition.Extent.Text
function script:curl {
    param([string[]]$Command)
    if ($script:mockFailure) {
        $script:LASTEXITCODE = 22
        return @('curl: (22) The requested URL returned error: 502')
    }
    $script:LASTEXITCODE = 0
    return @($script:mockBody)
}
# Test-Classroom 通过 & curl.exe 调用，这里用别名拦截。
New-Alias -Name curl.exe -Value script:curl -Force
$script:mockBody = '{"user":null,"config":{"asrReady":false}}'
if (-not (Test-Classroom 'https://classroom.example')) { throw '合法健康响应应通过，即使转写尚未配置。' }
$script:mockBody = '{"otherService":true}'
if (Test-Classroom 'https://classroom.example') { throw '其他服务返回 200 不应判为就绪。' }
$script:mockFailure = $true
if (Test-Classroom 'https://classroom.example') { throw '隧道失败不应判为就绪。' }
if ($script:healthError -notmatch '502') { throw '健康检查应保留错误原因。' }

# 只有独立控制台可被复用；旧课堂或其他服务返回 200 仍不可用。
$consoleDefinition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-LocalConsole' }, $true)
Invoke-Expression $consoleDefinition.Extent.Text
function Invoke-WebRequest {
    param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
    if ($script:consoleUnavailable) { throw 'connection refused' }
    return @{StatusCode=200; Content=$script:consoleBody}
}
$script:consoleBody = '{"console":true,"user":null}'
if (-not (Test-LocalConsole 4319)) { throw '独立控制台应通过检查。' }
$script:consoleBody = '{"user":null,"config":{}}'
if (Test-LocalConsole 4319) { throw '旧课堂响应不能替代独立控制台。' }
$script:consoleUnavailable = $true
if (Test-LocalConsole 4319) { throw '未监听的控制台不能判为就绪。' }
Write-Host '内测启动回归检查通过。'
