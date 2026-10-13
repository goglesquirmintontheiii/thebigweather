@echo off
rem Install or update TheBigWeather from the latest GitHub release (double-click me).
rem Options are passed on to install-latest.ps1, e.g.: install-latest.cmd -Portable
setlocal
set "PS1=%~dp0install-latest.ps1"
if not exist "%PS1%" (
  echo Downloading install-latest.ps1 ...
  set "PS1=%TEMP%\tbw-install-latest.ps1"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/goglesquirmintontheiii/thebigweather/releases/latest/download/install-latest.ps1' -OutFile '%TEMP%\tbw-install-latest.ps1'" || goto :fail
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
if errorlevel 1 goto :fail
echo.
pause
exit /b 0
:fail
echo.
echo Installation failed - see the messages above.
pause
exit /b 1
