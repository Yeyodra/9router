@echo off
setlocal
cd /d "%~dp0"

echo.
echo === 9Router: build + install global ===
echo.

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm not found. Install Node.js first.
  goto :fail
)

echo [0/3] Stopping running 9router (unlocks cli\app)...
powershell -NoProfile -NonInteractive -Command ^
  "$paths = @('*9router*','*\\cli\\app\\*','*\\cli/app/*');" ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object {" ^
  "  $cmd = $_.CommandLine;" ^
  "  if (-not $cmd) { return }" ^
  "  if ($cmd -match '9router|cli\\\\app|cli/app|custom-server\\.js') {" ^
  "    Write-Host ('  kill PID ' + $_.ProcessId);" ^
  "    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue" ^
  "  }" ^
  "};" ^
  "Start-Sleep -Seconds 1"
timeout /t 1 /nobreak >nul

if not exist "cli\node_modules\esbuild" (
  echo [1/3] Installing CLI deps...
  call npm install --prefix cli
  if errorlevel 1 goto :fail
) else (
  echo [1/3] CLI deps OK
)

echo [2/3] Building CLI pack...
call npm run cli:pack
if errorlevel 1 goto :fail

for /f "usebackq delims=" %%v in (`node -p "require('./cli/package.json').version"`) do set VER=%%v
if not exist "..\9router-%VER%.tgz" (
  echo ERROR: 9router-%VER%.tgz not found after pack.
  goto :fail
)

echo [3/3] Installing global 9router@%VER% ...
call npm install -g "..\9router-%VER%.tgz"
if errorlevel 1 goto :fail

echo.
echo DONE. Run: 9router
echo.
pause
exit /b 0

:fail
echo.
echo FAILED.
echo Tip: close 9router / tray, then retry. Or run:
echo   taskkill /F /IM node.exe
echo (kills ALL node processes)
echo.
pause
exit /b 1
