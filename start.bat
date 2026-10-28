@echo off
rem Serves this folder on http://localhost:8000 and opens the practice test app.
cd /d "%~dp0"
set PORT=8000
if not "%~1"=="" set PORT=%~1

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found on PATH. Install Python 3 from https://www.python.org/ and try again.
  pause
  exit /b 1
)

echo Practice test app running at http://localhost:%PORT%  (press Ctrl+C to stop)
start "" cmd /c "timeout /t 1 /nobreak >nul & start http://localhost:%PORT%"
python -m http.server %PORT% --bind 127.0.0.1
