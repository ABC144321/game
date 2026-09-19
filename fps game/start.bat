@echo off
cd /d %~dp0
echo Starting server on port 8080...
where node >nul 2>&1
if %errorlevel%==0 (
  node server.js
  goto :eof
)
where python >nul 2>&1
if %errorlevel%==0 (
  python -m http.server 8080
  goto :eof
)
where py >nul 2>&1
if %errorlevel%==0 (
  py -m http.server 8080
  goto :eof
)
echo Neither Node.js nor Python was found. Please install one of them.
pause
