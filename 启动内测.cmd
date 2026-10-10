@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\start-trial.ps1"
if errorlevel 1 (
  echo.
  echo 内测启动失败，请查看上方错误。按任意键关闭窗口。
  pause >nul
  exit /b 1
)
