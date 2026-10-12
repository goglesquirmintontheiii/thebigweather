@echo off
rem TheBigWeather server for Windows: double-click to start (runs start.ps1).
rem Pass options through, e.g.  start.cmd -InstallService   or   start.cmd -Domain wx.example.com
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
  echo.
  echo The server stopped with an error ^(code %RC%^).
  pause
)
endlocal & exit /b %RC%
