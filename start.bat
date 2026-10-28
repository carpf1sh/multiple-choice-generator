@echo off
rem Serves this folder on http://localhost:47823 in the background (no console window)
rem and opens the practice test app. Run stop.bat to shut the server down.
cd /d "%~dp0"
set PORT=47823
if not "%~1"=="" set PORT=%~1

where pythonw >nul 2>nul
if errorlevel 1 (
  echo Python was not found on PATH. Install Python 3 from https://www.python.org/ and try again.
  pause
  exit /b 1
)

rem Replace any hidden server left on the port by an earlier run, so the current server.pyw is always used.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127\.0\.0\.1:%PORT% .*LISTENING"') do (
  tasklist /fi "pid eq %%p" | findstr /i "pythonw.exe" >nul && taskkill /pid %%p /f >nul
)

start "" pythonw server.pyw %PORT%
timeout /t 1 /nobreak >nul

start "" http://localhost:%PORT%
