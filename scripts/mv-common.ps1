<#
  Shared by MediaVault.ps1 (status window) and Setup.ps1 (setup window): the settings file mediavault.json, the list of
  servers to run, the Windows shortcuts and running tailscale. Dot-source it. "mv-common.ps1 -PrintPorts" prints
  "{vault port} {sites port}" for the .bat files (start-console.bat, allow-firewall.bat); "-PrintDataDir" the library folder.

  mediavault.json (written by Setup.ps1; missing = the defaults below):
    vaultPort  Media Vault itself (0.0.0.0, so phones on home Wi-Fi and Tailscale can reach it)
    sitesPort  the sites server - the second PocketBase in pb_sites\ (pb_hooks/sites_lib.js reads this too)
    dataDir    where the library is stored (PocketBase's data folder: database, uploads, locked folder); missing =
               pb_data in this folder. Absolute, or relative to this folder. Setup sets it and moves the library.
    backends   site backends: more PocketBase servers that hosted sites call, e.g. CubeWord's accounts + cloud saves.
               Each is @{ name; dir (absolute, or relative to this folder); port (127.0.0.1 only); httpsPort; access =
               public (Tailscale Funnel) | tailnet (tailscale serve) | off; exeSha256 }. It runs from its own folder
               with its own pb_data/pb_hooks/pb_migrations/pb_public, using that folder's pocketbase.exe if it has one -
               only when that's the build below ($MvPbSha256) or the one approved in setup (exeSha256). Public ones
               get Media Vault's guard hook in their pb_hooks (Set-MvBackendGuard).
  The HTTPS layout is fixed: Media Vault on 8443 (tailnet only, never funnelled), the sites on 443.
#>
param([switch]$PrintPorts, [switch]$PrintDataDir)
# Media Vault's folder (these scripts are in its scripts folder).
$MvRoot = Split-Path $PSScriptRoot

$MvVaultHttps = 8443
$MvSitesHttps = 443
$MvFunnelPorts = @(443, 8443, 10000) # the only ports Tailscale Funnel can publish
$TsExe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
# One status window / one setup per copy of Media Vault (two copies on one PC each get their own).
$MvFolderId = -join ([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($MvRoot.TrimEnd('\').ToLowerInvariant()))[0..5] | ForEach-Object { $_.ToString('x2') })
$MvWindowMutex = "Local\MediaVaultStatusWindow-$MvFolderId"
$MvSetupMutex = "Local\MediaVaultSetup-$MvFolderId"

function Test-MvPort($p) { $n = 0; [int]::TryParse("$p", [ref]$n) -and $n -ge 1 -and $n -le 65535 }
function Resolve-MvDir([string]$Root, [string]$dir) { if ([IO.Path]::IsPathRooted($dir)) { $dir } else { Join-Path $Root $dir } }

function Get-MvConfig([string]$Root) {
  $c = @{ vaultPort = 8091; sitesPort = 8092; dataDir = ''; backends = @(); saved = $false }
  $file = Join-Path $Root 'mediavault.json'
  if (-not (Test-Path -LiteralPath $file)) { return $c }
  try { $j = [IO.File]::ReadAllText($file) | ConvertFrom-Json } catch { return $c }
  $c.saved = $true
  if (Test-MvPort $j.vaultPort) { $c.vaultPort = [int]$j.vaultPort }
  if (Test-MvPort $j.sitesPort) { $c.sitesPort = [int]$j.sitesPort }
  if ("$($j.dataDir)".Trim()) { $c.dataDir = "$($j.dataDir)".Trim().TrimEnd('\') }
  foreach ($b in @($j.backends)) {
    if (-not $b -or -not "$($b.dir)" -or -not (Test-MvPort $b.port)) { continue }
    $https = if (Test-MvPort $b.httpsPort) { [int]$b.httpsPort } else { 0 }
    $access = if ($https -and "$($b.access)" -in 'public', 'tailnet') { "$($b.access)" } else { 'off' }
    $name = if ("$($b.name)".Trim()) { "$($b.name)".Trim() } else { Split-Path -Leaf "$($b.dir)" }
    $sha = if ("$($b.exeSha256)" -match '^[0-9A-Fa-f]{64}$') { "$($b.exeSha256)".ToUpperInvariant() } else { '' }
    $c.backends += @(@{ name = $name; dir = "$($b.dir)"; port = [int]$b.port; httpsPort = $https; access = $access; exeSha256 = $sha })
  }
  $c
}

function Save-MvConfig([string]$Root, $c) {
  $out = [ordered]@{
    vaultPort = $c.vaultPort; sitesPort = $c.sitesPort
    backends = @($c.backends | ForEach-Object { [ordered]@{ name = $_.name; dir = $_.dir; port = $_.port; httpsPort = $_.httpsPort; access = $_.access; exeSha256 = "$($_.exeSha256)" } })
  }
  if ($c.dataDir) { $out.dataDir = $c.dataDir }
  # No BOM: sites_lib.js reads this with JSON.parse.
  [IO.File]::WriteAllText((Join-Path $Root 'mediavault.json'), (ConvertTo-Json $out -Depth 5), (New-Object Text.UTF8Encoding($false)))
}

# Files unzipped from a download keep Windows' "came from the internet" mark, so Windows can stop to ask about them -
# or, for pocketbase.exe started hidden by the window, quietly refuse. This takes the mark off Media Vault's own files
# (not the library, people's projects or the Android sources) and returns how many it cleared. It looks at a few files
# first and stops there if they're unmarked, so a normal start costs next to nothing.
function Test-MvMarked([string]$path) { [bool](Get-Item -LiteralPath $path -Stream Zone.Identifier -ErrorAction SilentlyContinue) }
function Unblock-MvFolder([string]$Root) {
  $probe = @('pocketbase.exe', 'start.bat', 'scripts\mv-common.ps1', 'pb_hooks\library.pb.js') | ForEach-Object { Join-Path $Root $_ }
  if (-not ($probe | Where-Object { (Test-Path -LiteralPath $_) -and (Test-MvMarked $_) })) { return 0 }
  $files = @(Get-ChildItem -LiteralPath $Root -File -Force -ErrorAction SilentlyContinue)
  foreach ($d in 'scripts', 'docs', 'pb_hooks', 'pb_migrations', 'pb_public', 'pb_sites\pb_hooks', 'pb_sites\pb_migrations', 'backends') {
    $p = Join-Path $Root $d
    if (Test-Path -LiteralPath $p) { $files += @(Get-ChildItem -LiteralPath $p -File -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\pb_data\\' }) }
  }
  $n = 0
  foreach ($f in $files) { if (Test-MvMarked $f.FullName) { try { Unblock-File -LiteralPath $f.FullName; $n++ } catch {} } }
  $n
}

# The library's folder (PocketBase's data: database, uploaded files, the status token): pb_data in this folder unless
# setup moved it (dataDir, absolute or relative to this folder).
# Only this account (plus SYSTEM and Administrators) may use the folder, when others could write to it: a new folder in
# C:\ or on another drive lets every account on the PC change it (inherited Users / Authenticated Users / Everyone),
# which would let them read the library or swap in code that runs as this user. The installer does the same for its
# folder (CurStepChanged in installer\MediaVault.iss). Grant first, then drop inheritance only if that worked, so the
# folder can't end up locked to everyone. Returns $true when it changed something.
function Protect-MvFolder([string]$dir) {
  if (-not $dir -or -not (Test-Path -LiteralPath $dir -PathType Container)) { return $false }
  $full = (Resolve-Path -LiteralPath $dir).ProviderPath.TrimEnd('\')
  if ($full.Length -le 3 -or $full.StartsWith('\\')) { return $false } # (a drive root, or a network folder - not ours to lock)
  $open = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545') # Everyone, Authenticated Users, Users
  $write = [Security.AccessControl.FileSystemRights]'WriteData, AppendData, Delete, ChangePermissions, TakeOwnership'
  $rules = (Get-Acl -LiteralPath $full).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  if (-not @($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $open -contains $_.IdentityReference.Value -and ($_.FileSystemRights -band $write) })) { return $false }
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $full /grant:r "*${me}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { return $false }
  & icacls.exe $full /inheritance:r | Out-Null
  $LASTEXITCODE -eq 0
}

function Get-MvDataDir([string]$Root, $c) { if ($c.dataDir) { Resolve-MvDir $Root $c.dataDir } else { Join-Path $Root 'pb_data' } }

# What MediaVault.ps1 starts: Media Vault, the sites server, then each backend. Keep start-console.bat's arguments for
# the first two in step.
function Get-MvServers([string]$Root, $c) {
  $exe = Join-Path $Root 'pocketbase.exe'
  # (Quoted here: Start-Process doesn't quote arguments with spaces.) The other folders are given too, since PocketBase
  # looks for pb_hooks and pb_migrations next to --dir by default - not here once the library is somewhere else.
  $vaultDir = if ($c.dataDir) { @('--dir', "`"$(Get-MvDataDir $Root $c)`"") } else { @() }
  $list = @(
    @{ Name = 'Media Vault'; Kind = 'vault'; Port = $c.vaultPort; Log = 'media-vault'; Exe = $exe; Dir = $Root
       Args = @('serve', '--http', "0.0.0.0:$($c.vaultPort)") + $vaultDir + @('--hooksDir', 'pb_hooks', '--migrationsDir', 'pb_migrations', '--publicDir', 'pb_public') },
    @{ Name = 'Sites'; Kind = 'sites'; Port = $c.sitesPort; Log = 'sites'; Exe = $exe; Dir = $Root
       Args = @('serve', '--http', "0.0.0.0:$($c.sitesPort)", '--dir', 'pb_sites\pb_data', '--hooksDir', 'pb_sites\pb_hooks',
                '--migrationsDir', 'pb_sites\pb_migrations', '--publicDir', 'pb_sites\www', '--indexFallback=false') }
  )
  foreach ($b in $c.backends) {
    $dir = Resolve-MvDir $Root $b.dir
    $own = Join-Path $dir 'pocketbase.exe'
    $slug = ($b.name.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
    if (-not $slug) { $slug = "port-$($b.port)" }
    # Relative paths, run from the backend's folder: Start-Process doesn't quote arguments with spaces, and without
    # --dir PocketBase would put pb_data next to whichever pocketbase.exe runs.
    $list += @(@{ Name = $b.name; Kind = 'backend'; Port = $b.port; Log = "backend-$slug"; Dir = $dir
       Exe = $(if (Test-Path -LiteralPath $own) { $own } else { $exe }); HttpsPort = $b.httpsPort; Access = $b.access; ExeSha256 = $b.exeSha256
       Args = @('serve', '--http', "127.0.0.1:$($b.port)", '--dir', 'pb_data', '--hooksDir', 'pb_hooks',
                '--migrationsDir', 'pb_migrations', '--publicDir', 'pb_public') })
  }
  foreach ($s in $list) { $s.Proc = $null; $s.StartedAt = $null }
  $list
}

# ---------- site backends: what Media Vault checks before running one ----------
# A backend's code runs with this Windows account's rights, so a backend's own pocketbase.exe only runs if it's the
# build Media Vault downloads ($MvPbSha256, below) or the file approved in setup (exeSha256). Throws if not.
function Get-MvFileHash([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
function Assert-MvBackendExe($s) {
  if ($s.Exe -eq (Join-Path $MvRoot 'pocketbase.exe')) { return }
  $h = Get-MvFileHash $s.Exe
  if ($h -ne $MvPbSha256 -and $h -ne $s.ExeSha256) { throw "its own pocketbase.exe isn't the one approved in setup (it may have been replaced) - open Setup to check it" }
}

# Public backends (Tailscale Funnel) get this hook in their pb_hooks: through Tailscale nobody can open the admin
# dashboard or act as a superuser, while on this PC (http://127.0.0.1:{port}/_/) everything works as usual. Requests
# via tailscale serve also come from 127.0.0.1; they're told apart by the Host and X-Forwarded-* headers it sets.
$MvGuardName = 'mediavault_guard.pb.js'
$MvGuardMark = '// Written by Media Vault'
$MvGuardJs = @'
// Written by Media Vault for a site backend it publishes with Tailscale Funnel - don't edit: it's rewritten every time
// Media Vault starts this backend, and removed once the backend isn't public. Through Tailscale (anything not sent
// straight to 127.0.0.1) the admin dashboard /_/, the _superusers collection and superuser tokens don't work; on this
// PC, http://127.0.0.1:{port}/_/ works as usual.
routerUse(new Middleware((e) => {
  const h = e.request.header;
  const host = (e.request.host || "").toLowerCase().replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  const direct = (host === "127.0.0.1" || host === "localhost" || host === "::1") &&
    !h.get("X-Forwarded-For") && !h.get("X-Forwarded-Host") && !h.get("Tailscale-Funnel-Request");
  if (direct) return e.next();

  const path = e.request.url.path;
  if (path === "/_" || path.startsWith("/_/")) throw new NotFoundError();
  const m = path.match(/^\/api\/collections\/([^/]+)/);
  if (m) {
    const su = $app.findCollectionByNameOrId("_superusers");
    const c = decodeURIComponent(m[1]).toLowerCase();
    if (c === "_superusers" || c === su.id.toLowerCase()) throw new NotFoundError();
  }
  for (const t of [(h.get("Authorization") || "").replace(/^Bearer\s+/i, ""), e.request.url.query().get("token")]) {
    if (!t) continue;
    let rec = null;
    try { rec = $app.findAuthRecordByToken(t); } catch (_) {}
    if (rec && rec.isSuperuser()) throw new ForbiddenError("Superusers can only sign in on the server's own PC.");
  }
  return e.next();
}, -99999, "mediavault_guard"));
'@
# Backends with an https address (public or tailnet) get flood protection too, the same as the sites server's
# (overLimit() in pb_sites/pb_hooks/serve_lib.js - keep the two in step): at most 300 requests per 10 seconds per
# visitor. Visitors through Tailscale all come from 127.0.0.1, so for those it's the address Tailscale adds last to
# X-Forwarded-For, which a visitor can't fake. Counted atomically in the backend's app store under "mvrl:" keys.
$MvFloodName = 'mediavault_flood.pb.js'
$MvFloodJs = @'
// Written by Media Vault for a site backend it gives an https address (Tailscale) - don't edit: it's rewritten every
// time Media Vault starts this backend, and removed once the backend has no https address. Flood protection: at most
// 300 requests per 10 seconds from one visitor; more get 429 "Too many requests" for the rest of those 10 seconds.
routerUse(new Middleware((e) => {
  const MAX = 300, WINDOW = 10;
  const remote = String(e.request.remoteAddr || "").replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  let ip = remote;
  if (remote === "127.0.0.1" || remote === "::1") {
    const xff = (e.request.header.get("X-Forwarded-For") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (xff.length) ip = xff[xff.length - 1];
  }
  const store = $app.store();
  const key = `mvrl:${Math.floor(Date.now() / 1000 / WINDOW)}:${ip}`;
  if (store.length() >= 50000 && !store.has(key)) return e.next(); // full: stop counting rather than block anyone
  let n = 0;
  store.setFunc(key, (old) => (n = (old || 0) + 1));
  if (n <= MAX) return e.next();
  e.response.header().set("Retry-After", String(WINDOW));
  return e.json(429, { status: 429, message: "Too many requests - wait a few seconds and try again.", data: {} });
}, -99000, "mediavault_flood"));

cronAdd("mediavaultFloodCounters", "* * * * *", () => {
  const store = $app.store(), cur = Math.floor(Date.now() / 1000 / 10);
  for (const k of Object.keys(store.getAll())) {
    const m = /^mvrl:(\d+):/.exec(k);
    if (m && +m[1] < cur) store.remove(k);
  }
});
'@
# One Media Vault hook file in a backend's pb_hooks: written when wanted (only if it differs - PocketBase restarts
# when hooks change), our copy taken out when not.
function Sync-MvBackendHook([string]$dir, [string]$name, [string]$js, [bool]$want) {
  $f = Join-Path $dir "pb_hooks\$name"
  $now = if (Test-Path -LiteralPath $f) { [IO.File]::ReadAllText($f) } else { $null }
  if ($want) {
    if ($now -ne $js) {
      New-Item -ItemType Directory -Force (Split-Path $f) | Out-Null
      [IO.File]::WriteAllText($f, $js, (New-Object Text.UTF8Encoding($false)))
    }
  } elseif ($now -and $now.StartsWith($MvGuardMark)) { Remove-Item -LiteralPath $f -Force -Confirm:$false }
}
# A backend's Media Vault hooks for its access: the guard when public, flood protection when it has an https address
# (public or tailnet), neither when it's this PC only. Throws if one can't be written.
function Set-MvBackendGuard([string]$dir, [string]$access) {
  Sync-MvBackendHook $dir $MvGuardName $MvGuardJs ($access -eq 'public')
  Sync-MvBackendHook $dir $MvFloodName $MvFloodJs ($access -in 'public', 'tailnet')
}

function Get-MvListenPid([int]$port) {
  try { (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess } catch { $null }
}
# The first local port from $from up that isn't in $taken and nothing listens on.
function Get-MvFreePort([int[]]$taken, [int]$from = 8093) {
  for ($p = $from; $p -lt 9900; $p++) { if ($taken -notcontains $p -and -not (Get-MvListenPid $p)) { return $p } }
  9900
}
# A backend's name from its folder: the first "rem" line of a .bat in it (e.g. "CubeWord save server (accounts +
# cloud saves)" -> "CubeWord save server"), else the folder name.
function Get-MvBackendName([string]$dir) {
  foreach ($bat in @(Get-ChildItem -LiteralPath $dir -Filter *.bat -ErrorAction SilentlyContinue)) {
    foreach ($line in @(Get-Content -LiteralPath $bat.FullName -TotalCount 5 -ErrorAction SilentlyContinue)) {
      $m = [regex]::Match($line, '^\s*rem\s+([^(.:]{3,40})', 'IgnoreCase')
      if ($m.Success) { return $m.Groups[1].Value.Trim() }
    }
  }
  Split-Path -Leaf $dir
}
# Creates the admin dashboard account (a superuser) in a PocketBase's data folder, or changes its password:
# @{ Ok; Out }. The password can't contain a double quote (it's passed on the command line).
function Set-MvSuperuser([string]$exe, [string]$dataDir, [string]$email, [string]$pass) {
  $psi = New-Object Diagnostics.ProcessStartInfo($exe, "superuser upsert `"$email`" `"$pass`" --dir `"$dataDir`"")
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.WorkingDirectory = Split-Path $dataDir
  $p = [Diagnostics.Process]::Start($psi)
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  $ui = [bool]('System.Windows.Forms.Application' -as [type])
  while (-not $p.WaitForExit(100)) { if ($ui) { [Windows.Forms.Application]::DoEvents() } }
  @{ Ok = $p.ExitCode -eq 0; Out = ([regex]::Replace("$($o.Result)`n$($e.Result)", '\x1B\[[0-9;]*[A-Za-z]', '')).Trim() }
}
# Stops whatever PocketBase listens on $port (and nothing that isn't PocketBase). True if one was stopped.
function Stop-MvPort([int]$port) {
  $id = Get-MvListenPid $port
  if (-not $id) { return $false }
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $p -or $p.ProcessName -ne 'pocketbase') { return $false }
  Stop-Process -Id $id -Force -Confirm:$false
  $until = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $until -and (Get-MvListenPid $port)) { Start-Sleep -Milliseconds 200 }
  $true
}

# ---------- PocketBase itself ----------
# pocketbase.exe isn't kept in git; setup downloads this exact build (the official Windows amd64 release, which also
# runs on Windows on ARM) and only accepts the file if its SHA-256 matches. To move to a newer PocketBase, change all
# three and check the hooks/migrations still work with it.
$MvPbVersion = '0.40.4'
$MvPbUrl = "https://github.com/pocketbase/pocketbase/releases/download/v$MvPbVersion/pocketbase_${MvPbVersion}_windows_amd64.zip"
$MvPbSha256 = 'D4A87770D4E0C62CD4B431385246B58A943D74CAEFA5477E9E1DA764B9CA671C'
# Downloads pocketbase.exe into $Root (plus its license as LICENSE-pocketbase.md). $onProgress gets the bytes downloaded
# so far. Throws if the download fails or the file isn't the expected one.
function Install-MvPocketBase([string]$Root, [scriptblock]$onProgress) {
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('mv-pocketbase-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force $tmp | Out-Null
  try {
    $zipPath = Join-Path $tmp 'pocketbase.zip'
    $wc = New-Object Net.WebClient
    $task = $wc.DownloadFileTaskAsync($MvPbUrl, $zipPath)
    $ui = [bool]('System.Windows.Forms.Application' -as [type])
    while (-not $task.IsCompleted) {
      if ($ui) { [Windows.Forms.Application]::DoEvents() }
      Start-Sleep -Milliseconds 100
      if ($onProgress -and (Test-Path -LiteralPath $zipPath)) { & $onProgress (Get-Item -LiteralPath $zipPath).Length }
    }
    if ($task.IsFaulted) { throw "couldn't download it ($($task.Exception.InnerException.Message))" }
    $zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
      foreach ($pair in @(@('pocketbase.exe', 'pocketbase.exe'), @('LICENSE.md', 'LICENSE-pocketbase.md'))) {
        $e = $zip.GetEntry($pair[0])
        if ($e) { [IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $tmp $pair[1]), $true) }
      }
    } finally { $zip.Dispose() }
    $exe = Join-Path $tmp 'pocketbase.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw "the download didn't contain pocketbase.exe" }
    if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $MvPbSha256) { throw "the downloaded pocketbase.exe isn't the expected file (checksum mismatch), so it wasn't used" }
    Move-Item -LiteralPath $exe -Destination (Join-Path $Root 'pocketbase.exe') -Force
    $lic = Join-Path $tmp 'LICENSE-pocketbase.md'
    if ((Test-Path -LiteralPath $lic) -and -not (Test-Path -LiteralPath (Join-Path $Root 'LICENSE-pocketbase.md'))) { Move-Item -LiteralPath $lic -Destination $Root }
  } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

# ---------- shortcuts ----------
# The app icon (the brand circle with a white "play" mark, as the status window draws it) as mediavault.ico, for the
# shortcuts: one 256px PNG image, which Windows scales down.
function Save-MvIcon([string]$path) {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object Drawing.Bitmap 256, 256
  $g = [Drawing.Graphics]::FromImage($bmp); $g.SmoothingMode = 'AntiAlias'
  $g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(109, 93, 252))), 8, 8, 240, 240)
  $g.FillPolygon([Drawing.Brushes]::White, [Drawing.Point[]]@((New-Object Drawing.Point 96, 72), (New-Object Drawing.Point 184, 128), (New-Object Drawing.Point 96, 184)))
  $g.Dispose()
  $ms = New-Object IO.MemoryStream; $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  $png = $ms.ToArray()
  $w = New-Object IO.BinaryWriter([IO.File]::Create($path))
  $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]1)                # header: icon, 1 image
  $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0)    # 256 x 256 (0 = 256), no palette
  $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$png.Length); $w.Write([UInt32]22)
  $w.Write($png); $w.Close()
}

$MvStartupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Media Vault.lnk'
$MvDesktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Media Vault.lnk'
# 'on' / 'off' / 'elsewhere' (a shortcut of that name that opens another copy of Media Vault) / 'stale' (one that opens
# a copy that isn't there any more, e.g. after the folder was moved).
function Get-MvShortcutState([string]$Root, [string]$lnk) {
  if (-not (Test-Path -LiteralPath $lnk)) { return 'off' }
  try { $l = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk) } catch { return 'elsewhere' }
  if ("$($l.Arguments)".IndexOf((Join-Path $PSScriptRoot 'MediaVault.ps1'), [StringComparison]::OrdinalIgnoreCase) -ge 0) { return 'on' }
  $m = [regex]::Match("$($l.Arguments)", '-File\s+"([^"]+)"')
  if ($m.Success -and -not (Test-Path -LiteralPath $m.Groups[1].Value)) { 'stale' } else { 'elsewhere' }
}
# A shortcut that opens the status window (which starts the servers); -Minimized for the Startup folder one.
function Set-MvShortcut([string]$Root, [string]$lnk, [bool]$on, [switch]$Minimized) {
  if (-not $on) { if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force -Confirm:$false }; return }
  $ico = Join-Path $Root 'mediavault.ico'
  if (-not (Test-Path -LiteralPath $ico)) { try { Save-MvIcon $ico } catch {} }
  $l = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $l.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $l.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $PSScriptRoot 'MediaVault.ps1')`"" + $(if ($Minimized) { ' -Minimized' } else { '' })
  $l.WorkingDirectory = $Root; $l.WindowStyle = 7
  $l.Description = if ($Minimized) { 'Starts Media Vault (status window minimized)' } else { 'Starts Media Vault and opens its status window' }
  if (Test-Path -LiteralPath $ico) { $l.IconLocation = "$ico,0" }
  $l.Save()
}

# ---------- tailscale ----------
# Runs tailscale with the window kept responsive (it can wait on a login page, e.g. when Funnel or HTTPS isn't allowed
# for the tailnet yet), giving up after 20 seconds. Needs System.Windows.Forms loaded.
function Invoke-Ts([string]$argLine) {
  $psi = New-Object Diagnostics.ProcessStartInfo($TsExe, $argLine)
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $p = [Diagnostics.Process]::Start($psi)
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  $until = (Get-Date).AddSeconds(20); $timedOut = $false
  while (-not $p.WaitForExit(100)) {
    [Windows.Forms.Application]::DoEvents()
    if ((Get-Date) -gt $until) { $timedOut = $true; try { $p.Kill() } catch {}; [void]$p.WaitForExit(2000); break }
  }
  $text = ''
  if ($o.Wait(2000)) { $text += $o.Result }
  if ($e.Wait(2000)) { $text += "`n" + $e.Result }
  @{ Ok = (-not $timedOut) -and $p.ExitCode -eq 0; TimedOut = $timedOut; Out = $text.Trim() }
}

# This machine's Tailscale state, with what `tailscale serve` sends where for its current name:
# Entries = @{ {https port} = @{ Port = local port it proxies to; Public = Funnel on } }. (Entries left from an old name
# of this machine are ignored here; the status window's Settings tab offers to clear them.)
function Get-MvTailscale {
  $t = @{ Installed = (Test-Path $TsExe); State = ''; Dns = ''; Ip = ''; Entries = @{} }
  if (-not $t.Installed) { return $t }
  try {
    $st = (& $TsExe status --json) | Out-String | ConvertFrom-Json
    $t.State = "$($st.BackendState)"; $t.Dns = "$($st.Self.DNSName)".TrimEnd('.'); $t.Ip = "$(@($st.Self.TailscaleIPs)[0])"
  } catch {}
  try {
    $sv = (& $TsExe serve status --json) | Out-String | ConvertFrom-Json
    if ($sv.Web) {
      foreach ($w in $sv.Web.PSObject.Properties) {
        $i = $w.Name.LastIndexOf(':')
        if ($t.Dns -and $w.Name.Substring(0, $i) -ne $t.Dns) { continue }
        $m = [regex]::Match("$($w.Value.Handlers.'/'.Proxy)", ':(\d+)/?$')
        if (-not $m.Success) { continue }
        $t.Entries[[int]$w.Name.Substring($i + 1)] = @{ Port = [int]$m.Groups[1].Value; Public = [bool]($sv.AllowFunnel -and $sv.AllowFunnel.($w.Name)) }
      }
    }
  } catch {}
  $t
}

if ($PrintPorts) { $c = Get-MvConfig $MvRoot; "$($c.vaultPort) $($c.sitesPort)" }
if ($PrintDataDir) { Get-MvDataDir $MvRoot (Get-MvConfig $MvRoot) }
