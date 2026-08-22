@echo off
setlocal EnableExtensions
REM ============================================================
REM  Material Roblox - one-click dependency fetcher
REM  Installs every dependency needed to build, run and package
REM  this project from the canonical npm registry into the
REM  project-local node_modules. Never machine-wide, never
REM  elevated, never any signing material.
REM
REM  Usage: download-dependencies.bat [/s | --silent]
REM         (also honours SILENT=1 in the environment)
REM ============================================================

set "SILENT="
if /i "%~1"=="/s" set "SILENT=1"
if /i "%~1"=="--silent" set "SILENT=1"
if /i "%SILENT_ENV%"=="1" set "SILENT=1"

set "PHASE_START=%TIME%"
echo [deps] phase 1/3: checking for a usable Node.js runtime...
where node >nul 2>nul
if errorlevel 1 (
  echo [deps] Node.js was not found on PATH.
  echo [deps] Install Node.js 20 or newer from https://nodejs.org - the
  echo [deps] project needs a real runtime and this script will not
  echo [deps] silently install one without you choosing it.
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do set "NODE_VER=%%v"
echo [deps] found Node %NODE_VER%

echo [deps] phase 2/3: installing project dependencies via npm ci/install...
if exist package-lock.json (
  echo [deps] lockfile present - using npm ci for exact versions
  call npm ci --no-audit --no-fund
) else (
  echo [deps] no lockfile - using npm install
  call npm install --no-audit --no-fund
)
if errorlevel 1 (
  echo [deps] FAILED: npm could not install dependencies. See npm output above.
  exit /b 1
)

echo [deps] phase 3/3: verifying key packages landed...
for %%p in ("node_modules\electron\package.json" "node_modules\pngjs\package.json" "node_modules\yaml\package.json" "node_modules\fflate\package.json" "node_modules\pdf-lib\package.json" "node_modules\isomorphic-git\package.json") do (
  if not exist %%p (
    echo [deps] FAILED: expected package missing: %%p
    exit /b 1
  )
)
echo [deps] all key packages present in node_modules.
echo [deps] done in %TIME% (started %PHASE_START%).
exit /b 0
