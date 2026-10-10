@echo off
chcp 65001 >nul
cd /d "%~dp0"
node --env-file-if-exists=.env scripts/open-console.js
if errorlevel 1 pause
