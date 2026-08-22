@echo off
setlocal EnableExtensions
REM ============================================================
REM  Material Roblox - one-click build (run out of the checkout)
REM  Fresh machine friendly: fetches dependencies itself, builds
REM  the real Electron app, verifies the binary, then offers to
REM  launch it. Silent mode for CI/agents: build.bat /s
REM  (also --silent or SILENT=1). Signing is permanently out of
REM  scope for this project - the output is intentionally unsigned.
REM ============================================================

set "SILENT="
if /i "%~1"=="/s" set "SILENT=1"
if /i "%~1"=="--silent" set "SILENT=1"
if /i "%SILENT_ENV%"=="1" set "SILENT=1"

echo [build] phase 1/5: vocabulary lock check (fail-open for outsiders)...
if exist scripts\check-vocabulary.mjs (
  node scripts\check-vocabulary.mjs
  if errorlevel 1 (
    echo [build] FAILED: the private vocabulary lock is stale. Re-run:
    echo [build]   node scripts\check-vocabulary.mjs --lock
    echo [build] after reading the current private dictionary, then rebuild.
    exit /b 1
  )
) else (
  echo [build] no lock script - skipping (outsider builds are allowed)
)

echo [build] phase 2/5: fetching dependencies...
call "%~dp0download-dependencies.bat" /s
if errorlevel 1 exit /b 1

echo [build] phase 3/5: guaranteeing the Electron binary...
call node scripts\ensure-electron.mjs
if errorlevel 1 (
  echo [build] FAILED: the Electron runtime binary could not be materialised.
  exit /b 1
)

echo [build] phase 4/5: generating the application icon set...
call node scripts\gen-icons.mjs
if errorlevel 1 (
  echo [build] FAILED: icon generation failed.
  exit /b 1
)

if not defined SILENT (
  echo [build] phase 5/5: launching the app from source...
  start "" "node_modules\electron\dist\electron.exe" "%~dp0."
  echo [build] the app is starting. Close it whenever you like.
  echo [build] tip: run build-installer.bat to produce the Squirrel installer.
) else (
  echo [build] phase 5/5: silent mode - skipping the interactive launch.
)
exit /b 0
