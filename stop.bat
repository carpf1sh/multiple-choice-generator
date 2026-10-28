@echo off
rem Stops the background server started by start.bat.
set PORT=47823
if not "%~1"=="" set PORT=%~1

set FOUND=
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127\.0\.0\.1:%PORT% .*LISTENING"') do (
  taskkill /pid %%p /f
  set FOUND=1
)

if defined FOUND (
  echo Practice test app server on port %PORT% stopped.
) else (
  echo No server is running on port %PORT%.
)
timeout /t 2 >nul
