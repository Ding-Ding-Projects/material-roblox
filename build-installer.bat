@echo off
setlocal EnableExtensions
REM ============================================================
REM  Material Roblox - one-click installer build
REM  Produces the same unsigned Squirrel.Windows installer the
REM  release workflow publishes: Setup exe, RELEASES and .nupkg
REM  under dist\squirrel-windows\. Never publishes, never tags,
REM  never signs - code signing is permanently out of scope and
REM  the output will say NotSigned on purpose.
REM  Silent mode: build-installer.bat /s (--silent or SILENT=1)
REM ============================================================

set "SILENT="
if /i "%~1"=="/s" set "SILENT=1"
if /i "%~1"=="--silent" set "SILENT=1"
if /i "%SILENT_ENV%"=="1" set "SILENT=1"

echo [installer] phase 1/4: vocabulary lock check (fail-open for outsiders)...
if exist scripts\check-vocabulary.mjs (
  node scripts\check-vocabulary.mjs
  if errorlevel 1 (
    echo [installer] FAILED: stale vocabulary lock - see build.bat note.
    exit /b 1
  )
)

echo [installer] phase 2/4: fetching dependencies...
call "%~dp0download-dependencies.bat" /s
if errorlevel 1 exit /b 1

echo [installer] phase 3/4: packaging via electron-builder (Squirrel target)...
call npx electron-builder --win squirrel --publish never
if errorlevel 1 (
  echo [installer] FAILED: electron-builder could not package the app.
  exit /b 1
)

echo [installer] phase 4/4: verifying the produced artifacts...
set "FOUND="
for %%f in ("dist\squirrel-windows\*.exe") do set "FOUND=%%~ff"
if not defined FOUND (
  echo [installer] FAILED: no setup executable found under dist\squirrel-windows\.
  dir dist\squirrel-windows 2>nul
  exit /b 1
)
if not exist "dist\squirrel-windows\RELEASES" (
  echo [installer] FAILED: RELEASES manifest missing from the output directory.
  exit /b 1
)
set "NUPKG="
for %%f in ("dist\squirrel-windows\*.nupkg") do set "NUPKG=%%~ff"
if not defined NUPKG (
  echo [installer] FAILED: no .nupkg found in the output directory.
  exit /b 1
)
echo [installer] artifacts:
echo   setup : %FOUND%
echo   rels  : dist\squirrel-windows\RELEASES
echo   nupkg : %NUPKG%
echo [installer] computing SHA-256 of the setup executable...
powershell -NoProfile -Command "(Get-FileHash -LiteralPath $env:FOUND -Algorithm SHA256).Hash"
echo [installer] note: this installer is intentionally UNSIGNED (project policy).
if not defined SILENT (
  choice /c YN /n /m "[installer] open the output folder now? [Y/N] "
  if not errorlevel 2 explorer "dist\squirrel-windows"
)
exit /b 0
