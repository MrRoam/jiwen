param([Parameter(Mandatory=$true)][string]$Url)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    $address = [Uri]$Url
    if ($address.Scheme -ne 'http' -or $address.Host -ne '127.0.0.1' -or $address.Port -lt 1 -or $address.AbsolutePath -ne '/') {
        throw '无效的本机控制台地址。'
    }
    $choice = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice' -ErrorAction SilentlyContinue
    $browserExe = $null
    if ($choice.ProgId) {
        $command = (Get-ItemProperty ('Registry::HKEY_CLASSES_ROOT\' + $choice.ProgId + '\shell\open\command') -ErrorAction SilentlyContinue).'(default)'
        if ($command -match '^\s*"([^"]+\.exe)"') { $browserExe = $matches[1] }
    }
    $name = if ($browserExe) { [IO.Path]::GetFileName($browserExe).ToLowerInvariant() } else { '' }
    # 独立窗口便于找到控制台；浏览器可见，启动辅助进程保持隐藏。
    if ($name -in @('chrome.exe','msedge.exe','firefox.exe') -and (Test-Path -LiteralPath $browserExe)) {
        $windowArgument = if ($name -eq 'firefox.exe') { '-new-window' } else { '--new-window' }
        Start-Process -FilePath $browserExe -ArgumentList $windowArgument,$Url -WindowStyle Normal -ErrorAction Stop
    } else {
        Start-Process -FilePath $Url -WindowStyle Normal -ErrorAction Stop
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
