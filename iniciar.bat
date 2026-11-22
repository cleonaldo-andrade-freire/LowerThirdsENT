@echo off
rem Lower Thirds ENT - inicia o servidor (instala as dependencias na primeira vez)
cd /d "%~dp0"
title Lower Thirds ENT

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERRO] Node.js nao encontrado. Instale a versao LTS em https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo  Instalando dependencias, aguarde...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  [ERRO] Falha ao instalar as dependencias. Verifique a internet e tente de novo.
    pause
    exit /b 1
  )
)

node server.js
echo.
echo  O servidor foi encerrado.
pause
