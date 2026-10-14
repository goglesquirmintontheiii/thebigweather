# Rebuilds TheBigWeather files from their parts and checks them.
# Usage:
#   - builds branch (downloaded as a ZIP and extracted): double-click join-windows.cmd in its folder;
#     it joins parts\<file>.partNN into <file> for the Windows files (or the names given) and checks SHA256SUMS.
#   - zipped release parts: put this next to the ...exe.partN.zip files (and SHA256.txt), then
#     right-click -> Run with PowerShell, or double-click join-windows.cmd.
param([string[]]$Names = @())
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
if ((Test-Path "parts") -and (Test-Path "SHA256SUMS")) {
  $sums = @{}
  foreach ($l in Get-Content "SHA256SUMS") { if ($l -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') { $sums[$Matches[2]] = $Matches[1].ToLower() } }
  if (-not $Names -or $Names.Count -eq 0) { $Names = @($sums.Keys | Where-Object { $_ -like "*.exe" -or $_ -like "*windows*" -or $_ -like "tbw-web-*" } | Sort-Object) }
  $bad = 0
  foreach ($name in $Names) {
    $parts = @(Get-ChildItem -LiteralPath "parts" | Where-Object { $_.Name -match ('^' + [regex]::Escape($name) + '\.part\d+$') } | Sort-Object Name)
    if ($parts.Count -eq 0) { Write-Host "No parts for $name"; $bad = 1; continue }
    $tmp = Join-Path $PSScriptRoot "$name.joining"
    $out = [System.IO.File]::Create($tmp)
    try { foreach ($p in $parts) { $in = [System.IO.File]::OpenRead($p.FullName); try { $in.CopyTo($out) } finally { $in.Close() } } } finally { $out.Close() }
    $have = (Get-FileHash -Algorithm SHA256 -LiteralPath $tmp).Hash.ToLower()
    if ($sums[$name] -ne $have) { Write-Host "Checksum mismatch for $name - a part is incomplete"; Remove-Item -Force $tmp; $bad = 1; continue }
    Move-Item -Force $tmp (Join-Path $PSScriptRoot $name)
    Write-Host "OK: $name (checksum verified)"
  }
  Read-Host "Done. Press Enter"
  exit $bad
}
$first = Get-ChildItem -Filter "TheBigWeather-*.exe.part0.zip" | Sort-Object Name | Select-Object -Last 1
if (-not $first) { Write-Host "Put this script next to the TheBigWeather-...exe.partN.zip files (or in the builds branch folder)"; Read-Host "Press Enter"; exit 1 }
$name = $first.Name -replace '\.part0\.zip$', ''
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("tbw-join-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
$i = 0
$out = [System.IO.File]::Create((Join-Path $PSScriptRoot $name))
try {
  while (Test-Path "$name.part$i.zip") {
    Expand-Archive -LiteralPath "$name.part$i.zip" -DestinationPath $tmp -Force
    $bytes = [System.IO.File]::ReadAllBytes((Join-Path $tmp "$name.part$i"))
    $out.Write($bytes, 0, $bytes.Length)
    $i++
  }
} finally { $out.Close(); Remove-Item -Recurse -Force $tmp }
if ($i -eq 0) { Write-Host "No parts found"; exit 1 }
$want = (Get-Content SHA256.txt | Where-Object { $_ -match [regex]::Escape($name) }) -split '\s+' | Select-Object -First 1
$have = (Get-FileHash -Algorithm SHA256 $name).Hash.ToLower()
if ($want -and $want.ToLower() -eq $have) { Write-Host "OK: $name (checksum verified)" } else { Write-Host "Checksum mismatch for $name - re-download the parts" ; exit 1 }
Read-Host "Done. Press Enter"
