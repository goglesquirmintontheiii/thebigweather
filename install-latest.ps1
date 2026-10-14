<#
.SYNOPSIS
  Install or update TheBigWeather from GitHub (Windows x64).

.DESCRIPTION
  .\install-latest.ps1                     desktop app (installer) + server bundle into %USERPROFILE%\TheBigWeather
  .\install-latest.ps1 -Portable           the portable desktop app instead of the installer
  .\install-latest.ps1 -AppOnly / -ServerOnly
  .\install-latest.ps1 -Dir D:\TBW -Version 0.8.0
  .\install-latest.ps1 -Source release     only the GitHub release (-Source repo: only the builds branch)
  Double-click install-latest.cmd to run it without changing the execution policy.

  Source: the newer of the latest GitHub release and the repository's "builds" branch. Builds-branch
  files come in parts that are checked and joined while downloading; an interrupted download
  resumes from the parts already there. Every download is SHA-256 checked. Re-running updates in
  place and keeps server\data (config, token, recordings). The installed app updates itself
  afterwards (Settings > Updates); the server updates with start.ps1 -Update or from Server settings.
#>
[CmdletBinding()]
param(
  [string]$Dir = (Join-Path $env:USERPROFILE "TheBigWeather"),
  [switch]$Portable,
  [switch]$AppOnly,
  [switch]$ServerOnly,
  [string]$Version = "",
  [ValidateSet("auto", "release", "repo")][string]$Source = "auto",
  [switch]$NoLaunch
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue" # Invoke-WebRequest is very slow with the progress bar
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$Repo = if ($env:TBW_REPO) { $env:TBW_REPO } else { "goglesquirmintontheiii/thebigweather" }
$Raw = if ($env:TBW_RAW_BASE) { $env:TBW_RAW_BASE.TrimEnd('/') } else { "https://raw.githubusercontent.com/$Repo" }
$Api = if ($env:TBW_API_BASE) { $env:TBW_API_BASE.TrimEnd('/') } else { "https://api.github.com" }
$Branch = if ($env:TBW_BUILDS_BRANCH) { $env:TBW_BUILDS_BRANCH } else { "builds" }
$UA = @{ "User-Agent" = "TheBigWeather-installer" }
function Say($m) { Write-Host "==> " -ForegroundColor Cyan -NoNewline; Write-Host $m }
function Die($m) { Write-Host "x $m" -ForegroundColor Red; exit 1 }

# ---------- versions (semver: a prerelease sorts before its release) ----------
function Split-Ver([string]$s) {
  $s = (($s.Trim()) -replace '^[vV]', '') -replace '\+.*$', ''
  $pre = ""
  $i = $s.IndexOf('-')
  if ($i -ge 0) { $pre = $s.Substring($i + 1); $s = $s.Substring(0, $i) }
  $c = $s.Split('.')
  $n = New-Object 'long[]' 3
  for ($k = 0; $k -lt 3 -and $k -lt $c.Length; $k++) { $v = [long]0; if ([long]::TryParse($c[$k], [ref]$v)) { $n[$k] = $v } }
  return @{ N = $n; P = $pre }
}
function Compare-Ver([string]$a, [string]$b) {
  $x = Split-Ver $a; $y = Split-Ver $b
  for ($k = 0; $k -lt 3; $k++) { if ($x.N[$k] -ne $y.N[$k]) { if ($x.N[$k] -gt $y.N[$k]) { return 1 } else { return -1 } } }
  $p = [string[]]@(); if ($x.P) { $p = [string[]]$x.P.Split('.') }
  $q = [string[]]@(); if ($y.P) { $q = [string[]]$y.P.Split('.') }
  if ($p.Length -eq 0 -and $q.Length -eq 0) { return 0 }
  if ($p.Length -eq 0) { return 1 }
  if ($q.Length -eq 0) { return -1 }
  for ($k = 0; $k -lt [Math]::Max($p.Length, $q.Length); $k++) {
    if ($k -ge $p.Length) { return -1 }
    if ($k -ge $q.Length) { return 1 }
    if ($p[$k] -ceq $q[$k]) { continue }
    $pn = $p[$k] -match '^\d+$'; $qn = $q[$k] -match '^\d+$'
    if ($pn -and $qn) { if ([long]$p[$k] -gt [long]$q[$k]) { return 1 } else { return -1 } }
    if ($pn) { return -1 }
    if ($qn) { return 1 }
    if ([string]::CompareOrdinal($p[$k], $q[$k]) -gt 0) { return 1 } else { return -1 }
  }
  return 0
}
if ($env:TBW_SELFTEST -eq "vercmp") { Compare-Ver $Dir $Version; exit 0 } # tests: -Dir A -Version B

function Get-Text($url, $headers = @{}) {
  $h = $UA.Clone(); foreach ($k in $headers.Keys) { $h[$k] = $headers[$k] }
  $r = Invoke-WebRequest -Uri $url -Headers $h -UseBasicParsing -TimeoutSec 30
  $c = $r.Content
  if ($c -is [byte[]]) { $c = [Text.Encoding]::UTF8.GetString($c) }
  return [string]$c
}

# ---------- what is available ----------
$rel = $null; $relV = ""
if ($Source -ne "repo") {
  $api = if ($Version) { "$Api/repos/$Repo/releases/tags/v$($Version.TrimStart('v'))" } else { "$Api/repos/$Repo/releases/latest" }
  Say "looking up the latest release ($Repo)"
  try { $rel = Invoke-RestMethod -Uri $api -Headers @{ Accept = "application/vnd.github+json"; "User-Agent" = "TheBigWeather-installer" } -TimeoutSec 30; $relV = $rel.tag_name -replace '^[vV]', '' } catch { $rel = $null }
  if ($relV) { Write-Host "    release: $relV" } else { Write-Host "    no release found" }
}
$man = $null; $manV = ""; $ref = $Branch
if ($Source -ne "release") {
  Say "looking up the $Branch branch"
  # pin every download to the branch's current commit, so a publish during the download can't mix
  # versions (the API is rate-limited: fall back to the branch name + per-part checksums)
  try { $sha = (Get-Text "$Api/repos/$Repo/commits/$Branch" @{ Accept = "application/vnd.github.sha" }).Trim(); if ($sha -match '^[0-9a-f]{40}$') { $ref = $sha } } catch {}
  try { $man = (Get-Text "$Raw/$ref/manifest.json") | ConvertFrom-Json } catch {
    if ($ref -ne $Branch) { $ref = $Branch; try { $man = (Get-Text "$Raw/$ref/manifest.json") | ConvertFrom-Json } catch { $man = $null } }
  }
  if ($man -and $man.version) { $manV = [string]$man.version; Write-Host "    $Branch branch: $manV" } else { Write-Host "    no builds on the $Branch branch" }
  if ($Version -and $manV -and (Compare-Ver $manV $Version) -ne 0) { $manV = "" }
}
if ($relV -and (-not $manV -or (Compare-Ver $relV $manV) -ge 0)) { $From = "release"; $V = $relV }
elseif ($manV) { $From = "repo"; $V = $manV }
else { $vv = if ($Version) { " v$Version" } else { "" }; Die "nothing to install: no release$vv and no builds found (offline? rate-limited?)" }
$fromText = if ($From -eq "release") { "the GitHub release" } else { "the repository's $Branch branch" }
Say "TheBigWeather $V (from $fromText)"

$tmp = Join-Path $env:TEMP ("tbw-install-" + [guid]::NewGuid())
$cache = Join-Path $Dir ".download"  # builds-branch downloads (kept until installed, so a re-run resumes)
New-Item -ItemType Directory -Force -Path $tmp, $Dir | Out-Null

# ---------- downloads ----------
function Asset($name) { $rel.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1 }
function Entry($name) { if ($man -and $man.files) { $p = $man.files.PSObject.Properties[$name]; if ($p) { return $p.Value } }; return $null }
function Has-Asset($name) { if ($From -eq "release") { return [bool](Asset $name) } else { return [bool](Entry $name) } }
function Hash-File($path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLower() }
function Hash-Range($path, [long]$off, [long]$len) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $fs = [System.IO.File]::OpenRead($path)
  try {
    [void]$fs.Seek($off, [System.IO.SeekOrigin]::Begin)
    $buf = New-Object byte[] 1048576
    $left = $len
    while ($left -gt 0) {
      $n = $fs.Read($buf, 0, [int][Math]::Min([long]$buf.Length, $left))
      if ($n -le 0) { break }
      [void]$sha.TransformBlock($buf, 0, $n, $null, 0)
      $left -= $n
    }
    [void]$sha.TransformFinalBlock((New-Object byte[] 0), 0, 0)
    return ([BitConverter]::ToString($sha.Hash) -replace '-', '').ToLower()
  } finally { $fs.Close(); $sha.Dispose() }
}

# builds branch: download every part, check it, append it; check the whole file at the end
function Fetch-Repo($name) {
  $e = Entry $name
  if (-not $e) { Die "the $Branch branch has no $name" }
  New-Item -ItemType Directory -Force -Path $cache | Out-Null
  $out = Join-Path $cache $name
  $have = [long]0; if (Test-Path -LiteralPath $out) { $have = (Get-Item -LiteralPath $out).Length }
  $parts = @($e.parts)
  Write-Host "    downloading $name ($([math]::Round($e.size / 1MB)) MB in $($parts.Count) parts)"
  $off = [long]0; $keep = $true; $i = 0
  foreach ($p in $parts) {
    $i++
    $ps = [long]$p.size
    if ($keep -and $have -ge ($off + $ps) -and (Hash-Range $out $off $ps) -eq $p.sha256) {
      Write-Host "    part $i/$($parts.Count) already here"; $off += $ps; continue
    }
    if ($keep) {
      $keep = $false
      $fs = [System.IO.File]::Open($out, [System.IO.FileMode]::OpenOrCreate); try { $fs.SetLength($off) } finally { $fs.Close() }
    }
    $pf = "$out.part"
    $ok = $false
    for ($try = 1; $try -le 3 -and -not $ok; $try++) {
      Write-Host "    part $i/$($parts.Count)"
      try {
        Invoke-WebRequest -Uri "$Raw/$ref/$($p.path)" -OutFile $pf -UseBasicParsing -Headers $UA -TimeoutSec 900
        if ((Get-Item -LiteralPath $pf).Length -eq $ps -and (Hash-File $pf) -eq $p.sha256) { $ok = $true } else { Write-Host "    part $i/$($parts.Count): checksum mismatch, retrying" }
      } catch { Write-Host "    part $i/$($parts.Count): $($_.Exception.Message)" }
      if (-not $ok) { Start-Sleep -Seconds 2 }
    }
    if (-not $ok) { Remove-Item -Force -LiteralPath $pf -ErrorAction SilentlyContinue; Die "can't download $($p.path) (if a new build was published meanwhile, run this again)" }
    $fo = [System.IO.File]::Open($out, [System.IO.FileMode]::Append)
    try { $fi = [System.IO.File]::OpenRead($pf); try { $fi.CopyTo($fo) } finally { $fi.Close() } } finally { $fo.Close() }
    Remove-Item -Force -LiteralPath $pf
    $off += $ps
  }
  if ((Get-Item -LiteralPath $out).Length -gt $off) { $fs = [System.IO.File]::Open($out, [System.IO.FileMode]::Open); try { $fs.SetLength($off) } finally { $fs.Close() } }
  if ((Get-Item -LiteralPath $out).Length -ne [long]$e.size -or (Hash-File $out) -ne $e.sha256) { Remove-Item -Force -LiteralPath $out; Die "checksum mismatch for $name after joining (run again)" }
  Write-Host "    ${name}: checksum verified"
  return $out
}
$script:sumLines = $null
function Fetch-Release($name) {
  $a = Asset $name
  if (-not $a) { Die "release v$V has no $name" }
  if (-not $script:sumLines) {
    $sums = Asset "SHA256SUMS"
    if (-not $sums) { Die "release v$V has no SHA256SUMS" }
    Invoke-WebRequest -Uri $sums.browser_download_url -OutFile (Join-Path $tmp "SHA256SUMS") -UseBasicParsing
    $script:sumLines = Get-Content (Join-Path $tmp "SHA256SUMS")
  }
  Write-Host "    downloading $name ($([math]::Round($a.size / 1MB)) MB)"
  $out = Join-Path $tmp $name
  Invoke-WebRequest -Uri $a.browser_download_url -OutFile $out -UseBasicParsing
  $want = $script:sumLines | Where-Object { $_ -match "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($name))$" } | ForEach-Object { $Matches[1].ToLower() } | Select-Object -First 1
  $got = Hash-File $out
  if (-not $want -or $want -ne $got) { Die "checksum mismatch for $name (download corrupted?)" }
  return $out
}
function Fetch($name) { if ($From -eq "release") { return (Fetch-Release $name) } else { return (Fetch-Repo $name) } }

# ---------- install ----------
try {
  if (-not $AppOnly) {
    $zipName = "tbw-server-$V-windows-x86_64.zip"
    if (Has-Asset $zipName) {
      $zip = Fetch $zipName
      Say "installing the server into $Dir"
      $x = Join-Path $tmp "x"
      Expand-Archive -Path $zip -DestinationPath $x -Force
      $src = Join-Path $x "TheBigWeather-server"
      $svc = $null; try { $svc = Get-Service -Name "TheBigWeather" -ErrorAction SilentlyContinue } catch {}
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
      if ($From -eq "repo") { Remove-Item -Force -LiteralPath $zip -ErrorAction SilentlyContinue }
      if ($wasRunning) { & sc.exe start TheBigWeather | Out-Null; Write-Host "    restarted the TheBigWeather service" }
      Write-Host "    start it with: $Dir\start.cmd   (or start.ps1 -InstallService to run it at boot)"
    } else { Write-Host "    (version $V has no Windows server bundle)" }
  }
  if (-not $ServerOnly) {
    if ($Portable) {
      $p = Fetch "TheBigWeather-$V-portable.exe"
      $dst = Join-Path $Dir "TheBigWeather-portable.exe"
      Move-Item -Force $p $dst
      Say "portable app: $dst (it updates itself: Settings > Updates)"
      if (-not $NoLaunch) { Start-Process $dst }
    } else {
      $setup = Fetch "TheBigWeather-$V-setup.exe"
      Say "running the installer (the app updates itself afterwards: Settings > Updates)"
      # /S = silent per-user install into %LOCALAPPDATA%\Programs\TheBigWeather
      $proc = Start-Process -FilePath $setup -ArgumentList "/S" -PassThru -Wait
      if ($proc.ExitCode -ne 0) { Die "the installer failed ($($proc.ExitCode))" }
      if ($From -eq "repo") { Remove-Item -Force -LiteralPath $setup -ErrorAction SilentlyContinue }
      $exe = Join-Path $env:LOCALAPPDATA "Programs\TheBigWeather\TheBigWeather.exe"
      if ((Test-Path $exe) -and -not $NoLaunch) { Start-Process $exe }
    }
  }
  if ((Test-Path -LiteralPath $cache) -and -not (Get-ChildItem -Force -LiteralPath $cache)) { Remove-Item -Force -LiteralPath $cache }
  Say "done"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
