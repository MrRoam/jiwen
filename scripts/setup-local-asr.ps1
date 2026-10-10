param(
  [ValidateSet('whisper','paraformer-streaming')][string]$Engine = 'whisper',
  [ValidateSet('cpu','cuda')][string]$Device = 'cpu',
  [string]$Python = 'python',
  [switch]$SkipInstall,
  [switch]$DownloadModel
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskVenv = Join-Path $taskRoot '.venv-asr'
$taskPython = Join-Path $taskVenv 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) {
  & $Python -m venv $taskVenv
  if ($LASTEXITCODE -ne 0) { throw '无法建立独立 Python 环境。' }
}
if (-not $SkipInstall) {
  & $taskPython -m pip install --upgrade pip
  if ($LASTEXITCODE -ne 0) { throw 'pip 更新失败。' }
  if ($Engine -eq 'paraformer-streaming') {
    # CUDA 12.8 包包含 Blackwell 支持；CPU 安装不会下载 GPU 运行库。
    $taskIndex = if ($Device -eq 'cuda') { 'https://download.pytorch.org/whl/cu128' } else { 'https://download.pytorch.org/whl/cpu' }
    & $taskPython -m pip install 'torch==2.10.0' 'torchaudio==2.10.0' --index-url $taskIndex
    if ($LASTEXITCODE -ne 0) { throw 'PyTorch 安装失败，请检查 Python 版本与所选设备。' }
    & $taskPython -m pip install -r (Join-Path $taskRoot 'server\requirements-asr.txt')
  } else {
    & $taskPython -m pip install -r (Join-Path $taskRoot 'server\requirements-local-asr.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Whisper 依赖安装失败。' }
    & $taskPython -m pip install 'truststore>=0.10,<1'
  }
  if ($LASTEXITCODE -ne 0) { throw '本地转写依赖安装失败。' }
}
if ($Engine -eq 'paraformer-streaming') {
  & $taskPython -c "import torch; print({'torch': torch.__version__, 'cudaVersion': torch.version.cuda, 'cudaAvailable': torch.cuda.is_available()}); assert '$Device' != 'cuda' or torch.cuda.is_available(), 'CUDA unavailable'; print(torch.ones(2, device='$Device').sum().item())"
} else {
  & $taskPython -c "import ctranslate2; print({'ctranslate2': ctranslate2.__version__, 'cudaDevices': ctranslate2.get_cuda_device_count()}); assert '$Device' != 'cuda' or ctranslate2.get_cuda_device_count() > 0, 'CUDA unavailable'"
}
if ($LASTEXITCODE -ne 0) { throw '设备验证失败；没有启动服务，也没有修改应用配置。' }
if ($DownloadModel) {
  if ($Engine -ne 'paraformer-streaming') { throw '-DownloadModel 仅用于固定许可版本的流式模型。' }
  $taskCommit = 'fd2af606b37d7fb8b3b8a218c5be5b07b53ef6ba'
  $taskModelDirectory = Join-Path $taskRoot "output\local-asr-models\$taskCommit"
  New-Item -ItemType Directory -Path $taskModelDirectory -Force | Out-Null
  $taskModelManifest = Join-Path $taskModelDirectory 'asr-source.json'
  $taskReuseModel = $false
  if (Test-Path -LiteralPath $taskModelManifest) {
    try {
      $taskExistingManifest = Get-Content -LiteralPath $taskModelManifest -Raw -Encoding UTF8 | ConvertFrom-Json
      $taskWeightPath = Join-Path $taskModelDirectory 'model.pt'
      $taskReuseModel = $taskExistingManifest.commit -eq $taskCommit -and (Test-Path -LiteralPath $taskWeightPath) -and (Get-FileHash -LiteralPath $taskWeightPath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $taskExistingManifest.modelSha256
    } catch { $taskReuseModel = $false }
  }
  foreach ($taskName in @('LICENSE','README.md','config.yaml','configuration.json','am.mvn','seg_dict','tokens.json','model.pt','example/asr_example.wav')) {
    $taskTarget = Join-Path $taskModelDirectory $taskName
    New-Item -ItemType Directory -Path (Split-Path -Parent $taskTarget) -Force | Out-Null
    if ($taskReuseModel -and (Test-Path -LiteralPath $taskTarget)) { continue }
    Write-Host "下载固定模型文件：$taskName"
    # 临时文件完成后才替换目标，避免将中断下载当作完整模型。
    Invoke-WebRequest -UseBasicParsing -Uri "https://huggingface.co/funasr/paraformer-zh-streaming/resolve/$taskCommit/$taskName" -OutFile "$taskTarget.partial"
    Move-Item -LiteralPath "$taskTarget.partial" -Destination $taskTarget -Force
  }
  if (-not $taskReuseModel) {
    @{repository='funasr/paraformer-zh-streaming';revision='apache-2.0-20260804';commit=$taskCommit;modelSha256=(Get-FileHash -LiteralPath (Join-Path $taskModelDirectory 'model.pt') -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json | Set-Content -LiteralPath $taskModelManifest -Encoding UTF8
  }
  Write-Host "固定模型目录：$taskModelDirectory"
  Write-Host "启动时增加：--model-path '$taskModelDirectory'"
}
Write-Host "独立环境已准备好：$taskPython"
Write-Host "启动命令：& '$taskPython' server/local_asr.py --engine $Engine --device $Device"
Write-Host '设备探测不等于真实模型推理验证；启动后使用 benchmark-local-asr.py 测试。'
