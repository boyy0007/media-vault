<#
  Makes Media-Vault-setup-{date}.zip next to this folder: a clean copy for setting Media Vault up on another PC (or
  for someone else) - the program (pocketbase.exe, hooks, migrations, the app, the scripts) without your library,
  logs, settings, hosted sites or the Android signing key. Site backends from mediavault.json come along as
  backends\{name}\ (their code - pb_hooks, pb_migrations, pb_public - not their data), each with a backend.json so
  setup offers them. On the other PC: unzip, run start.bat (it opens setup the first time).
  To move this install WITH its data, copy the folder instead - see docs\MOVING.md.

    powershell -ExecutionPolicy Bypass -File scripts\make-package.ps1 [-Out D:\somewhere\file.zip]
  -Folder D:\somewhere\new-folder puts the same files in a folder instead of a zip (make-installer.ps1 uses that).
#>
param([string]$Out, [string]$Folder)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot # (the scripts are in Media Vault's scripts folder)
. (Join-Path $PSScriptRoot 'mv-common.ps1')
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (-not $Out) { $Out = Join-Path (Split-Path $Root) "Media-Vault-setup-$(Get-Date -Format yyyy-MM-dd).zip" }

if ($Folder) {
  if ((Test-Path -LiteralPath $Folder) -and @(Get-ChildItem -LiteralPath $Folder -Force).Count) { throw "$Folder isn't empty" }
  $stage = ''; $dest = $Folder
} else {
  $stage = Join-Path ([IO.Path]::GetTempPath()) ('mv-package-' + [guid]::NewGuid().ToString('N'))
  $dest = Join-Path $stage 'Media Vault'
}
New-Item -ItemType Directory -Force $dest | Out-Null
function Copy-Dir([string]$from, [string]$to) {
  if (-not (Test-Path -LiteralPath $from -PathType Container)) { return }
  New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
  Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
}
try {
  foreach ($f in 'pocketbase.exe', 'start.bat', 'setup.bat', 'start-console.bat', 'allow-firewall.bat', 'README.md', 'LICENSE',
                 'LICENSE-pocketbase.md', 'LICENSE.md', 'projects\README.txt') {
    $p = Join-Path $Root $f
    if (Test-Path -LiteralPath $p) { New-Item -ItemType Directory -Force (Split-Path (Join-Path $dest $f)) | Out-Null; Copy-Item -LiteralPath $p -Destination (Join-Path $dest $f) }
  }
  foreach ($d in 'scripts', 'docs', 'pb_hooks', 'pb_migrations', 'pb_public', 'pb_sites\pb_hooks', 'pb_sites\pb_migrations') { Copy-Dir (Join-Path $Root $d) (Join-Path $dest $d) }
  New-Item -ItemType Directory -Force (Join-Path $dest 'pb_sites\www') | Out-Null

  $cfg = Get-MvConfig $Root
  $names = @{}
  foreach ($b in $cfg.backends) {
    $src = Resolve-MvDir $Root $b.dir
    $slug = ($b.name.ToLower() -replace '[^a-z0-9]+', '-').Trim('-'); if (-not $slug) { $slug = "backend-$($b.port)" }
    while ($names[$slug]) { $slug += '-2' }; $names[$slug] = $true
    $bd = Join-Path $dest "backends\$slug"
    New-Item -ItemType Directory -Force $bd | Out-Null
    foreach ($d in 'pb_hooks', 'pb_migrations', 'pb_public') { Copy-Dir (Join-Path $src $d) (Join-Path $bd $d) }
    # (Media Vault's own hooks are written again when the backend starts on the other PC.)
    foreach ($h in $MvGuardName, $MvFloodName) { Remove-Item -LiteralPath (Join-Path $bd "pb_hooks\$h") -Force -ErrorAction SilentlyContinue }
    $info = [ordered]@{ name = $b.name; port = $b.port; httpsPort = $b.httpsPort; access = $b.access }
    [IO.File]::WriteAllText((Join-Path $bd 'backend.json'), (ConvertTo-Json $info), (New-Object Text.UTF8Encoding($false)))
    Write-Host "Backend: $($b.name) (from $src)"
  }

  if ($Folder) { Write-Host "Staged in $Folder"; return }
  if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force -Confirm:$false }
  # Entries by hand: Windows PowerShell's CreateFromDirectory writes "\" in the names, which other systems unzip as flat files.
  $zip = [IO.Compression.ZipFile]::Open($Out, 'Create')
  try {
    foreach ($f in Get-ChildItem -LiteralPath $stage -Recurse -File -Force) {
      $name = $f.FullName.Substring($stage.Length + 1).Replace('\', '/')
      [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $name, 'Optimal')
    }
    foreach ($d in Get-ChildItem -LiteralPath $stage -Recurse -Directory -Force) {
      if (-not @(Get-ChildItem -LiteralPath $d.FullName -Force).Count) { [void]$zip.CreateEntry($d.FullName.Substring($stage.Length + 1).Replace('\', '/') + '/') }
    }
  } finally { $zip.Dispose() }
  Write-Host ("Made {0} ({1:N1} MB). On the other PC: unzip it and run start.bat." -f $Out, ((Get-Item -LiteralPath $Out).Length / 1MB))
} finally {
  if ($stage) { Remove-Item -LiteralPath $stage -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue }
}
