# Rebuilds a TheBigWeather .exe from its zipped parts and checks it.
# Usage: put this next to the part zips (and SHA256.txt), then right-click → Run with PowerShell,
# or double-click join-windows.cmd.
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
$first = Get-ChildItem -Filter "TheBigWeather-*.exe.part0.zip" | Sort-Object Name | Select-Object -Last 1
if (-not $first) { Write-Host "Put this script next to the TheBigWeather-...exe.partN.zip files"; Read-Host "Press Enter"; exit 1 }
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
