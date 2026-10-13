<#
.SYNOPSIS
  TheBigWeather server launcher for Windows (PowerShell 5.1+). The Windows twin of start.sh.

.DESCRIPTION
  .\start.ps1                          set up (first run) and start the server in this window
  .\start.ps1 -Domain wx.example.com   serve over HTTPS with Caddy for that domain
  .\start.ps1 -InstallService          install + start a Windows service (runs at boot; needs admin)
  .\start.ps1 -UninstallService        remove the service (and the Caddy service)
  .\start.ps1 -Token / -NewToken       print / regenerate the app access token
  .\start.ps1 -Update                  update to the latest GitHub release (SHA-256 checked), then start
  Double-click start.cmd to run it without changing the execution policy.

  Portable mode keeps everything under server\data next to this script. A service keeps its
  config and data under %ProgramData%\TheBigWeather (an existing portable config is copied there).
#>
[CmdletBinding()]
param(
  [string]$Domain = "",
  [string]$Email = "",
  [switch]$Lan,
  [int]$Port = 8787,
  [switch]$InstallService,
  [switch]$UninstallService,
  [switch]$ScheduledTask,      # use a startup scheduled task instead of a Windows service
  [int]$MemoryMB = -1,
  [int]$CpuPercent = -1,
  [switch]$Rebuild,
  [switch]$NewToken,
  [switch]$Token,
  [switch]$ShowProfile,
  [switch]$NoTools,            # don't offer ffmpeg / yt-dlp
  [switch]$Update,             # update the server (+ web app) to the latest GitHub release, then start
  [switch]$CheckUpdate,        # only show whether a newer release exists
  [switch]$NoFirewall
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$Root      = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = Join-Path $Root "server"
$BinDir    = Join-Path $ServerDir "bin"
$Bin       = Join-Path $BinDir "tbw-server.exe"
$Caddy     = Join-Path $BinDir "caddy.exe"
$CaddyVersion = "2.10.2"
$ServiceName  = "TheBigWeather"
$CaddyService = "TheBigWeatherCaddy"
$TaskName     = "TheBigWeather server"
$ProgramDataDir = Join-Path $env:ProgramData "TheBigWeather"

function Step($m) { Write-Host "==> " -ForegroundColor Cyan -NoNewline; Write-Host $m -ForegroundColor White }
function Ok($m)   { Write-Host "    + " -ForegroundColor Green -NoNewline; Write-Host $m }
function Info($m) { Write-Host "    $m" -ForegroundColor DarkGray }
function Warn($m) { Write-Host "    ! " -ForegroundColor Yellow -NoNewline; Write-Host $m }
function Die($m)  { Write-Host "x $m" -ForegroundColor Red; exit 1 }

function Is-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Service-Exists($name) { return [bool](Get-Service -Name $name -ErrorAction SilentlyContinue) }
# UTF-8 without BOM (PowerShell 5.1's -Encoding UTF8 adds one, which TOML parsers reject)
function Write-Utf8($path, $text) {
  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false))
}

if ($PSVersionTable.PSVersion.Major -lt 5) { Die "PowerShell 5.1 or newer is needed." }
if ([Environment]::OSVersion.Platform -ne "Win32NT") { Die "This script is for Windows. On Linux run ./start.sh" }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$Version = "dev"
$vf = Join-Path $ServerDir "VERSION"
if (Test-Path $vf) { $Version = (Get-Content $vf -Raw).Trim() }
Write-Host ""
Write-Host "  TheBigWeather server  " -ForegroundColor White -NoNewline
Write-Host $Version -ForegroundColor DarkGray
Write-Host ""

# ---------- service removal ----------
if ($UninstallService) {
  Step "Removing the service"
  if (-not (Is-Admin)) { Die "Run this from an administrator PowerShell (right-click > Run as administrator)." }
  foreach ($s in @($ServiceName, $CaddyService)) {
    if (Service-Exists $s) {
      & sc.exe stop $s | Out-Null
      Start-Sleep -Seconds 2
      & sc.exe delete $s | Out-Null
      Ok "removed service $s"
    }
  }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Ok "removed scheduled task"
  }
  Get-NetFirewallRule -DisplayName "TheBigWeather*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Info "Data in $ProgramDataDir was kept."
  exit 0
}

$UseService = $InstallService -or (Service-Exists $ServiceName)
if ($UseService) { $DataDir = Join-Path $ProgramDataDir "data" } else { $DataDir = Join-Path $ServerDir "data" }
$Config    = Join-Path $DataDir "config.toml"
$Caddyfile = Join-Path $DataDir "Caddyfile"

# ---------- 1. optional tools ----------
Step "Checking optional tools"
function Try-Winget($id, $name) {
  if (-not (Have "winget")) { Warn "winget not found; install $name yourself if you want it"; return }
  try {
    Info "winget install $id"
    & winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | Out-Null
    # winget changes PATH for new shells only
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  } catch { Warn "couldn't install $name ($($_.Exception.Message))" }
}
$exeSide = { param($n) Test-Path (Join-Path $BinDir $n) }
if ((Have "ffmpeg") -or (& $exeSide "ffmpeg.exe")) { Ok "ffmpeg" }
elseif (-not $NoTools) {
  Warn "ffmpeg not found - installing it for camera video recording (optional)"
  Try-Winget "Gyan.FFmpeg" "ffmpeg"
  if (Have "ffmpeg") { Ok "ffmpeg" } else { Warn "no ffmpeg; video camera recording stays off (put ffmpeg.exe in server\bin to enable it)" }
} else { Info "ffmpeg skipped (-NoTools)" }
# yt-dlp: the server runs server\bin\yt-dlp.exe before anything on PATH. Earlier versions copied
# a winget yt-dlp there once (for the service) and never refreshed it, so it went stale while the
# PATH copy was updated. Now the copy the server uses is compared with the latest release on
# every start and replaced by the official standalone yt-dlp.exe when outdated.
$YtLocal = Join-Path $BinDir "yt-dlp.exe"
function Yt-Latest {
  try {
    $r = Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest" -Method Head -UseBasicParsing -TimeoutSec 10 -MaximumRedirection 5
    $u = $r.BaseResponse.ResponseUri; if (-not $u) { $u = $r.BaseResponse.RequestMessage.RequestUri }
    if ("$u" -match "/tag/([0-9.]+)$") { return $Matches[1] }
  } catch {}
  return ""
}
function Yt-Version($exe) { if (-not $exe) { return "" }; try { return ((& $exe --version 2>$null) | Select-Object -First 1) } catch { return "" } }
function Yt-Older($v, $latest) {
  if (-not $v) { return $true }
  if ($latest) { try { return ([version]($v -replace '^(\d+\.\d+\.\d+).*$', '$1')) -lt ([version]($latest -replace '^(\d+\.\d+\.\d+).*$', '$1')) -or (($v -ne $latest) -and ($v.Length -lt $latest.Length) -and $latest.StartsWith($v)) } catch { return $v -ne $latest } }
  try { $d = [datetime]::ParseExact(($v.Substring(0, 10)), "yyyy.MM.dd", $null); return ((Get-Date) - $d).TotalDays -gt 120 } catch { return $false }
}
$ytExe = if (Test-Path $YtLocal) { $YtLocal } else { $c = Get-Command "yt-dlp" -ErrorAction SilentlyContinue; if ($c) { $c.Source } else { $null } }
$ytVer = Yt-Version $ytExe
if ($NoTools -and -not $ytExe) { Info "yt-dlp skipped (-NoTools)" }
else {
  $ytLatest = Yt-Latest
  if ($ytVer -and -not (Yt-Older $ytVer $ytLatest)) { Ok "yt-dlp $ytVer ($ytExe)" }
  else {
    if ($ytVer) { Warn "yt-dlp $ytVer is outdated (latest: $ytLatest) - updating it for YouTube camera recording (optional)" }
    else { Warn "yt-dlp not found - installing it for YouTube camera recording (optional)" }
    try {
      $tmp = Join-Path $BinDir "yt-dlp.new.exe"
      Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile $tmp -UseBasicParsing -TimeoutSec 180
      if (Yt-Version $tmp) { Move-Item -Force $tmp $YtLocal; Ok ("yt-dlp " + (Yt-Version $YtLocal) + " (in server\bin; the server uses this copy)") }
      else { Remove-Item -Force $tmp -ErrorAction SilentlyContinue; throw "downloaded yt-dlp.exe doesn't run" }
    } catch {
      if ($ytVer) { Warn "couldn't update yt-dlp ($($_.Exception.Message)); YouTube recording may fail until it's updated" }
      else { Warn "couldn't install yt-dlp; YouTube camera recording stays off" }
    }
  }
}
if ($UseService) {
  # services run as LocalSystem, whose PATH may not include per-user winget installs: copy them next to the server
  foreach ($t in @("ffmpeg")) {
    $c = Get-Command $t -ErrorAction SilentlyContinue
    $dst = Join-Path $BinDir "$t.exe"
    if ($c -and $c.Source -and -not (Test-Path $dst)) {
      try { Copy-Item $c.Source $dst -ErrorAction Stop; Info "copied $t.exe next to the server for the service" } catch {}
    }
  }
}

# ---------- 2. server binary ----------
Step "Preparing the server binary"
New-Item -ItemType Directory -Force -Path $BinDir, $DataDir | Out-Null
function Bin-Works {
  if (-not (Test-Path $Bin)) { return $false }
  try { & $Bin --version 2>&1 | Out-Null; return ($LASTEXITCODE -eq 0) } catch { return $false }
}
function Build-FromSource {
  if (-not (Have "cargo")) {
    $cb = Join-Path $env:USERPROFILE ".cargo\bin"
    if (Test-Path (Join-Path $cb "cargo.exe")) { $env:Path = "$cb;$env:Path" }
  }
  if (-not (Have "cargo")) {
    Write-Host ""
    Warn "No prebuilt server\bin\tbw-server.exe and no Rust toolchain."
    Info "Either copy a prebuilt tbw-server.exe into $BinDir,"
    Info "or install Rust: winget install Rustlang.Rustup   (then: rustup default stable-msvc;"
    Info "it needs the Visual Studio C++ Build Tools and CMake:"
    Info "  winget install Microsoft.VisualStudio.2022.BuildTools --override ""--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"""
    Info "  winget install Kitware.CMake)"
    Info "and run this script again."
    exit 1
  }
  Info "building from source (first build takes several minutes)"
  Push-Location $ServerDir
  try {
    & cargo build --release
    if ($LASTEXITCODE -ne 0) { Die "Build failed. See the errors above." }
  } finally { Pop-Location }
  Copy-Item (Join-Path $ServerDir "target\release\tbw-server.exe") $Bin -Force
  Ok "built $Bin"
}
if ($Rebuild -or -not (Bin-Works)) {
  if ((Test-Path $Bin) -and -not (Bin-Works)) { Warn "the binary in server\bin doesn't run on this system - rebuilding" }
  Build-FromSource
} else {
  Ok ("using " + ((& $Bin --version) -join " "))
}

# ---------- update from GitHub releases ----------
$Repo = if ($env:TBW_UPDATE_REPO) { $env:TBW_UPDATE_REPO } else { "goglesquirmintontheiii/thebigweather" }
function Do-Update {
  Step "Checking for a newer release ($Repo)"
  try { $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ Accept = "application/vnd.github+json"; "User-Agent" = "TheBigWeather-start" } -TimeoutSec 30 }
  catch { Warn "couldn't reach the GitHub API ($($_.Exception.Message))"; return }
  $ver = ($rel.tag_name -replace '^[vV]', '')
  $cur = ""
  if (Test-Path $Bin) { try { $cur = (((& $Bin --version) -join " ") -split " ")[1] } catch {} }
  if ($cur -and ([version]$ver -le [version]$cur)) { Ok "up to date ($cur)"; return }
  Info "installed: $(if ($cur) { $cur } else { 'none' }) - latest: $ver"
  if ($CheckUpdate) { return }
  $name = "tbw-server-$ver-windows-x86_64.exe"
  $asset = $rel.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
  $sums = $rel.assets | Where-Object { $_.name -eq "SHA256SUMS" } | Select-Object -First 1
  if (-not $asset -or -not $sums) { Warn "release $($rel.tag_name) has no $name or SHA256SUMS"; return }
  $tmp = Join-Path $env:TEMP ("tbw-update-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    Invoke-WebRequest -Uri $sums.browser_download_url -OutFile (Join-Path $tmp "SHA256SUMS") -UseBasicParsing
    Info "downloading $name"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile (Join-Path $tmp $name) -UseBasicParsing
    $want = (Get-Content (Join-Path $tmp "SHA256SUMS") | Where-Object { $_ -match "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($name))$" } | ForEach-Object { $Matches[1].ToLower() } | Select-Object -First 1)
    $got = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $name)).Hash.ToLower()
    if (-not $want -or $want -ne $got) { Warn "checksum mismatch for $name - not installed"; return }
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq "Running") { & sc.exe stop $ServiceName | Out-Null; Start-Sleep -Seconds 4 }
    if (Test-Path $Bin) { Move-Item -Force $Bin "$Bin.old" }
    Move-Item -Force (Join-Path $tmp $name) $Bin
    Ok "server $ver installed (previous kept as tbw-server.exe.old)"
    $web = "tbw-web-$ver.zip"
    $wa = $rel.assets | Where-Object { $_.name -eq $web } | Select-Object -First 1
    $dist = Join-Path $Root "app\dist"
    if ($wa -and (Test-Path $dist)) {
      try {
        Invoke-WebRequest -Uri $wa.browser_download_url -OutFile (Join-Path $tmp $web) -UseBasicParsing
        $ww = (Get-Content (Join-Path $tmp "SHA256SUMS") | Where-Object { $_ -match "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($web))$" } | ForEach-Object { $Matches[1].ToLower() } | Select-Object -First 1)
        if ($ww -eq (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $web)).Hash.ToLower()) {
          $new = "$dist.new"; Remove-Item -Recurse -Force $new -ErrorAction SilentlyContinue
          Expand-Archive -Path (Join-Path $tmp $web) -DestinationPath $new -Force
          Remove-Item -Recurse -Force "$dist.old" -ErrorAction SilentlyContinue
          Move-Item $dist "$dist.old"; Move-Item $new $dist
          Ok "web app updated"
        } else { Warn "web app checksum mismatch - not updated" }
      } catch { Warn "web app not updated ($($_.Exception.Message))" }
    }
    Write-Utf8 (Join-Path $ServerDir "VERSION") $ver
    if ($svc -and $svc.Status -eq "Running") { & sc.exe start $ServiceName | Out-Null; Ok "restarted the service"; exit 0 }
  } catch { Warn "update failed: $($_.Exception.Message)" }
  finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
if ($Update -or $CheckUpdate) {
  Do-Update
  if ($CheckUpdate) { exit 0 }
}

# ---------- small commands ----------
if ($Token) { & $Bin -c $Config token; exit 0 }
if ($NewToken) {
  Write-Host ("New token: " + ((& $Bin -c $Config new-token) -join ""))
  Warn "Apps using the old token must be updated. Restart the server to apply."
  exit 0
}
if ($ShowProfile) { & $Bin -c $Config profile; exit 0 }

# ---------- 3. config ----------
Step "Configuration"
function Get-Cfg($key) {
  if (-not (Test-Path $Config)) { return "" }
  $m = Select-String -Path $Config -Pattern ("^" + [regex]::Escape($key) + "\s*=\s*""?([^""]*)""?") | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value } else { return "" }
}
function Set-Cfg($key, $value, [switch]$Number) {
  $text = [IO.File]::ReadAllText($Config)
  $v = if ($Number) { "$value" } else { '"' + ($value -replace '\\', '\\' -replace '"', '\"') + '"' }
  $pat = "(?m)^" + [regex]::Escape($key) + "\s*=.*$"
  $line = "$key = $v"
  $re = New-Object Text.RegularExpressions.Regex $pat
  if ($re.IsMatch($text)) { $text = $re.Replace($text, [Text.RegularExpressions.MatchEvaluator] { param($m) $line }, 1) }
  elseif ($Number) {
    $pre = New-Object Text.RegularExpressions.Regex "(?m)^\[profile\]\s*$"
    $text = $pre.Replace($text, [Text.RegularExpressions.MatchEvaluator] { param($m) "[profile]`n$line" }, 1)
  }
  Write-Utf8 $Config $text
}

if (-not (Test-Path $Config)) {
  $portable = Join-Path $ServerDir "data\config.toml"
  if ($UseService -and (Test-Path $portable)) {
    Copy-Item $portable $Config
    Ok "copied your existing config (same token) to $Config"
  } else {
    & $Bin -c $Config token | Out-Null
    Ok "created $Config"
    if (-not $Domain -and -not $Email -and -not $Lan -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
      Write-Host ""
      Write-Host "    First-run setup (press Enter to skip any question)"
      $Domain = Read-Host "    Domain for HTTPS (e.g. wx.example.com, blank = none)"
      $Email = Read-Host "    Contact email for the NWS API (recommended)"
      Write-Host ""
    }
  }
  Set-Cfg "data_dir" "data"
}
# the web UI: app\dist next to this script (absolute, so it works from %ProgramData% too)
$web = Join-Path $Root "app\dist"
if (Test-Path (Join-Path $web "index.html")) { Set-Cfg "web_dir" $web }

if ($Domain) { Set-Cfg "public_url" "https://$Domain" }
else {
  $existing = Get-Cfg "public_url"
  if ($existing -like "https://*" -and -not $Lan) { $Domain = $existing.Substring(8) }
}
if ($Email) { Set-Cfg "user_agent" "TheBigWeather/$Version ($Email)" }
if ($Domain) {
  Set-Cfg "bind" "127.0.0.1:$Port"
  Ok "HTTPS mode for $Domain (server listens on 127.0.0.1:$Port behind Caddy)"
} else {
  Set-Cfg "bind" "0.0.0.0:$Port"
  Ok "LAN mode: http://<this-computer>:$Port"
}
if ($MemoryMB -ge 0) { Set-Cfg "memory_mb" $MemoryMB -Number; Ok "memory budget: $MemoryMB MB" }
if ($CpuPercent -ge 0) {
  if ($CpuPercent -lt 1 -or $CpuPercent -gt 100) { Die "-CpuPercent must be 1-100" }
  Set-Cfg "cpu_percent" $CpuPercent -Number; Ok "CPU share: $CpuPercent%"
}
try {
  $prof = (& $Bin -c $Config profile) -join "`n" | ConvertFrom-Json
  Info ("profile: {0} - {1} cores - {2} GB RAM - {3} decode threads - {4} MB cache" -f $prof.name, $prof.cores, $prof.ram_gb, $prof.threads, $prof.memory_mb)
} catch {}

# ---------- 4. firewall ----------
if (-not $NoFirewall) {
  if (Is-Admin) {
    try {
      Get-NetFirewallRule -DisplayName "TheBigWeather*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
      if ($Domain) {
        New-NetFirewallRule -DisplayName "TheBigWeather HTTPS" -Direction Inbound -Protocol TCP -LocalPort 80,443 -Action Allow | Out-Null
        Ok "firewall: opened ports 80 and 443"
      } else {
        New-NetFirewallRule -DisplayName "TheBigWeather server" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private,Domain | Out-Null
        Ok "firewall: opened port $Port on private networks"
      }
    } catch { Warn "couldn't add a firewall rule: $($_.Exception.Message)" }
  } else {
    Info "not administrator: Windows may ask to allow tbw-server through the firewall on first start"
  }
}

# ---------- 5. HTTPS (Caddy) ----------
if ($Domain) {
  Step "HTTPS with Caddy"
  if (-not (Test-Path $Caddy)) {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
    $url = "https://github.com/caddyserver/caddy/releases/download/v$CaddyVersion/caddy_${CaddyVersion}_windows_$arch.zip"
    Info "downloading Caddy $CaddyVersion"
    $tmp = Join-Path $env:TEMP ("tbw-caddy-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
      Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp "caddy.zip") -UseBasicParsing
      Expand-Archive -Path (Join-Path $tmp "caddy.zip") -DestinationPath $tmp -Force
      Copy-Item (Join-Path $tmp "caddy.exe") $Caddy
    } catch { Die "Could not download Caddy from $url ($($_.Exception.Message))" }
    finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
  }
  Ok ("caddy " + ((& $Caddy version) -split " ")[0])
  $global = if ($Email) { "`temail $Email`n" } else { "" }
  Write-Utf8 $Caddyfile @"
{
$global	admin off
	storage file_system {
		root "$(($DataDir -replace '\\','/'))/caddy-data"
	}
}

$Domain {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$Port {
		flush_interval -1
	}
}
"@
  Ok "wrote $Caddyfile"
  try {
    $ip = (Resolve-DnsName $Domain -Type A -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress
    if ($ip) { Info "$Domain resolves to $ip" }
  } catch { Warn "$Domain doesn't resolve yet - HTTPS will fail until DNS points here" }
}

# ---------- 6. service / startup task ----------
if ($InstallService) {
  if (-not (Is-Admin)) { Die "Installing a service needs an administrator PowerShell (right-click > Run as administrator)." }
  if ($ScheduledTask) {
    Step "Installing a startup task"
    $act = New-ScheduledTaskAction -Execute $Bin -Argument "-c `"$Config`" run" -WorkingDirectory $ProgramDataDir
    $trg = New-ScheduledTaskTrigger -AtStartup
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Settings $set -User "SYSTEM" -RunLevel Highest -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Ok "scheduled task '$TaskName' runs the server at startup (as SYSTEM)"
  } else {
    Step "Installing the Windows service"
    if (Service-Exists $ServiceName) { & sc.exe stop $ServiceName | Out-Null; Start-Sleep 2; & sc.exe delete $ServiceName | Out-Null; Start-Sleep 1 }
    # tbw-server has a built-in service mode: `tbw-server -c <config> service`
    $binPath = "`"$Bin`" -c `"$Config`" service"
    & sc.exe create $ServiceName binPath= $binPath start= delayed-auto DisplayName= "TheBigWeather server" | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "sc.exe create failed (try -ScheduledTask instead)" }
    & sc.exe description $ServiceName "TheBigWeather radar and weather data server" | Out-Null
    & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/60000 | Out-Null
    & sc.exe start $ServiceName | Out-Null
    Start-Sleep 2
    if ((Get-Service $ServiceName).Status -eq "Running") { Ok "service $ServiceName running" } else { Warn "service didn't start - check Event Viewer > Windows Logs > Application" }
    if ($Domain) {
      if (Service-Exists $CaddyService) { & sc.exe stop $CaddyService | Out-Null; Start-Sleep 2; & sc.exe delete $CaddyService | Out-Null; Start-Sleep 1 }
      # Caddy runs as a Windows service by itself
      & sc.exe create $CaddyService binPath= "`"$Caddy`" run --config `"$Caddyfile`" --adapter caddyfile" start= auto DisplayName= "TheBigWeather HTTPS (Caddy)" | Out-Null
      & sc.exe failure $CaddyService reset= 86400 actions= restart/5000/restart/10000/restart/60000 | Out-Null
      & sc.exe start $CaddyService | Out-Null
      Ok "service $CaddyService running"
    }
  }
  Info "config: $Config"
}

# ---------- 7. connection info ----------
$TokenValue = ((& $Bin -c $Config token) -join "").Trim()
if ($Domain) { $Url = "https://$Domain" } else {
  $lan = $null
  try {
    $lan = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.PrefixOrigin -ne "WellKnown" } |
      Sort-Object -Property InterfaceMetric | Select-Object -First 1 -ExpandProperty IPAddress
  } catch {}
  if (-not $lan) { $lan = "localhost" }
  $Url = "http://${lan}:$Port"
}
Step "Connect your apps"
Write-Host "    Server URL : " -NoNewline; Write-Host $Url -ForegroundColor White
Write-Host "    Token      : " -NoNewline; Write-Host $TokenValue -ForegroundColor White
Info "In the desktop app: Settings > Server > add URL + token (no token needed on this computer)."
Info "A browser at $Url also works (paste the token when asked)."
Write-Host ""

if ($InstallService) { exit 0 }
if (Service-Exists $ServiceName) {
  if ((Get-Service $ServiceName).Status -eq "Running") {
    Warn "The TheBigWeather service is already running. Stop it first: sc.exe stop $ServiceName"
    exit 1
  }
}

# ---------- 8. run ----------
$caddyProc = $null
if ($Domain -and -not ((Service-Exists $CaddyService) -and (Get-Service $CaddyService).Status -eq "Running")) {
  Step "Starting Caddy"
  $caddyProc = Start-Process -FilePath $Caddy -ArgumentList @("run", "--config", "`"$Caddyfile`"", "--adapter", "caddyfile") -WorkingDirectory $DataDir -NoNewWindow -PassThru `
    -RedirectStandardOutput (Join-Path $DataDir "caddy.log") -RedirectStandardError (Join-Path $DataDir "caddy.err.log")
  Start-Sleep 1
  if ($caddyProc.HasExited) { Warn "Caddy exited - see $DataDir\caddy.err.log" } else { Ok "Caddy running (log: $DataDir\caddy.err.log)" }
}
Step "Starting server (Ctrl+C to stop)"
try {
  Push-Location (Split-Path -Parent $DataDir)
  & $Bin -c $Config run
} finally {
  Pop-Location
  if ($caddyProc -and -not $caddyProc.HasExited) { Stop-Process -Id $caddyProc.Id -Force -ErrorAction SilentlyContinue }
}
