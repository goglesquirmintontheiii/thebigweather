@echo off
rem Install or update TheBigWeather from GitHub: the latest release or repository build (double-click me).
rem Options are passed on to install-latest.ps1, e.g.: install-latest.cmd -Portable
setlocal
set "PS1=%~dp0install-latest.ps1"
if not exist "%PS1%" (
  echo Downloading install-latest.ps1 ...
  set "PS1=%TEMP%\tbw-install-latest.ps1"
  rem from the latest release, else the builds branch, else main
  powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; $o='%TEMP%\tbw-install-latest.ps1'; foreach ($u in 'https://github.com/goglesquirmintontheiii/thebigweather/releases/latest/download/install-latest.ps1','https://raw.githubusercontent.com/goglesquirmintontheiii/thebigweather/builds/install-latest.ps1','https://raw.githubusercontent.com/goglesquirmintontheiii/thebigweather/main/install-latest.ps1') { try { Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $o; exit 0 } catch {} }; exit 1" || goto :fail
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
