<#
.SYNOPSIS
  Install or update TheBigWeather from the latest GitHub release (Windows x64).

.DESCRIPTION
  .\install-latest.ps1                     desktop app (installer) + server bundle into %USERPROFILE%\TheBigWeather
  .\install-latest.ps1 -Portable           the portable desktop app instead of the installer
  .\install-latest.ps1 -AppOnly / -ServerOnly
  .\install-latest.ps1 -Dir D:\TBW -Version 0.8.0
  Double-click install-latest.cmd to run it without changing the execution policy.

  Every download is checked against the release's SHA256SUMS. Re-running updates in place and
  keeps server\data (config, token, recordings). The installed app updates itself afterwards
  (Settings > Updates); the server updates with start.ps1 -Update or from Server settings.
#>
[CmdletBinding()]
param(
  [string]$Dir = (Join-Path $env:USERPROFILE "TheBigWeather"),
  [switch]$Portable,
  [switch]$AppOnly,
  [switch]$ServerOnly,
  [string]$Version = "",
  [switch]$NoLaunch
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue" # Invoke-WebRequest is very slow with the progress bar
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$Repo = if ($env:TBW_REPO) { $env:TBW_REPO } else { "goglesquirmintontheiii/thebigweather" }
function Say($m) { Write-Host "==> " -ForegroundColor Cyan -NoNewline; Write-Host $m }
function Die($m) { Write-Host "x $m" -ForegroundColor Red; exit 1 }

$api = if ($Version) { "https://api.github.com/repos/$Repo/releases/tags/v$($Version.TrimStart('v'))" } else { "https://api.github.com/repos/$Repo/releases/latest" }
Say "looking up the release ($Repo)"
try { $rel = Invoke-RestMethod -Uri $api -Headers @{ Accept = "application/vnd.github+json"; "User-Agent" = "TheBigWeather-installer" } -TimeoutSec 30 }
catch { Die "can't reach the GitHub API ($($_.Exception.Message))" }
$V = $rel.tag_name -replace '^[vV]', ''
Say "TheBigWeather $V"

$tmp = Join-Path $env:TEMP ("tbw-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $tmp, $Dir | Out-Null
function Asset($name) { $rel.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1 }
$sums = Asset "SHA256SUMS"
if (-not $sums) { Die "release $($rel.tag_name) has no SHA256SUMS" }
Invoke-WebRequest -Uri $sums.browser_download_url -OutFile (Join-Path $tmp "SHA256SUMS") -UseBasicParsing
$sumLines = Get-Content (Join-Path $tmp "SHA256SUMS")
function Fetch($name) {
  $a = Asset $name
  if (-not $a) { Die "release $($rel.tag_name) has no $name" }
  Write-Host "    downloading $name ($([math]::Round($a.size / 1MB)) MB)"
  $out = Join-Path $tmp $name
  Invoke-WebRequest -Uri $a.browser_download_url -OutFile $out -UseBasicParsing
  $want = $sumLines | Where-Object { $_ -match "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($name))$" } | ForEach-Object { $Matches[1].ToLower() } | Select-Object -First 1
  $got = (Get-FileHash -Algorithm SHA256 $out).Hash.ToLower()
  if (-not $want -or $want -ne $got) { Die "checksum mismatch for $name (download corrupted?)" }
  return $out
}

try {
  if (-not $AppOnly) {
    $zipName = "tbw-server-$V-windows-x86_64.zip"
    if (Asset $zipName) {
      $zip = Fetch $zipName
      Say "installing the server into $Dir"
      $x = Join-Path $tmp "x"
      Expand-Archive -Path $zip -DestinationPath $x -Force
      $src = Join-Path $x "TheBigWeather-server"
      $svc = Get-Service -Name "TheBigWeather" -ErrorAction SilentlyContinue
      $wasRunning = $svc -and $svc.Status -eq "Running"
      if ($wasRunning) { & sc.exe stop TheBigWeather | Out-Null; Start-Sleep -Seconds 4 }
      foreach ($d in @("server\bin", "server\data", "app")) { New-Item -ItemType Directory -Force -Path (Join-Path $Dir $d) | Out-Null }
      $bin = Join-Path $Dir "server\bin\tbw-server.exe"
      if (Test-Path $bin) { Move-Item -Force $bin "$bin.old" }
      Copy-Item -Force (Join-Path $src "server\bin\*") (Join-Path $Dir "server\bin\")
      Copy-Item -Force (Join-Path $src "server\VERSION") (Join-Path $Dir "server\VERSION")
      Copy-Item -Force (Join-Path $src "server\data\*.json") (Join-Path $Dir "server\data\")
      $dist = Join-Path $Dir "app\dist"
      Remove-Item -Recurse -Force "$dist.old" -ErrorAction SilentlyContinue
      if (Test-Path $dist) { Move-Item $dist "$dist.old" }
      Copy-Item -Recurse (Join-Path $src "app\dist") $dist
      foreach ($f in @("start.ps1", "start.cmd", "install-latest.ps1", "install-latest.cmd", "README.md")) {
        $p = Join-Path $src $f; if (Test-Path $p) { Copy-Item -Force $p (Join-Path $Dir $f) }
      }
      if ($wasRunning) { & sc.exe start TheBigWeather | Out-Null; Write-Host "    restarted the TheBigWeather service" }
      Write-Host "    start it with: $Dir\start.cmd   (or start.ps1 -InstallService to run it at boot)"
    } else { Write-Host "    (this release has no Windows server bundle)" }
  }
  if (-not $ServerOnly) {
    if ($Portable) {
      $p = Fetch "TheBigWeather-$V-portable.exe"
      $dst = Join-Path $Dir "TheBigWeather-portable.exe"
      Move-Item -Force $p $dst
      Say "portable app: $dst (download a new one to update: the portable version can't update itself)"
      if (-not $NoLaunch) { Start-Process $dst }
    } else {
      $setup = Fetch "TheBigWeather-$V-setup.exe"
      Say "running the installer (the app updates itself afterwards: Settings > Updates)"
      # /S = silent per-user install into %LOCALAPPDATA%\Programs\TheBigWeather
      $proc = Start-Process -FilePath $setup -ArgumentList "/S" -PassThru -Wait
      if ($proc.ExitCode -ne 0) { Die "the installer failed ($($proc.ExitCode))" }
      $exe = Join-Path $env:LOCALAPPDATA "Programs\TheBigWeather\TheBigWeather.exe"
      if ((Test-Path $exe) -and -not $NoLaunch) { Start-Process $exe }
    }
  }
  Say "done"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
