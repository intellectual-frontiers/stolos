# Stolos bootstrap for Windows (spec 062).
#
# Makes this PC a Stolos controller: the PC you manage a fleet from. In order,
# each step checking first and doing nothing when it is already done (so
# running it again is always safe):
#
#   1. Bun, the engine's runtime, at the version the engine pins: its official
#      release archive for this PC, unpacked (into %USERPROFILE%\.bun\bin; no
#      Administrator needed) only when its SHA-256 is the pinned one. Node 26
#      instead, with --runtime node, or where Bun cannot run here.
#   2. Git (winget: Git.Git).
#   3. gh, GitHub's command line (winget: GitHub.cli).
#   4. Your GitHub sign-in (gh auth login, in the browser), and Git told to use
#      it (gh auth setup-git): no SSH key or token to make by hand.
#   5. The fleet repository: cloned into --in (default $HOME\fleet) when it is
#      not there, and its engine installed (bun install --frozen-lockfile:
#      exactly what its bun.lock holds); brought up to date (bun run stolos
#      update) when it is.
#   6. A shortcut: `stolos ...` for `bun run stolos ...`, in your PowerShell
#      profile (Windows PowerShell and PowerShell 7). PowerShell runs a profile
#      only when scripts may run, so this also sets your own execution policy
#      to RemoteSigned when it is Restricted. Skip both with --no-shortcut.
#
# This is the bootstrap, published with every Stolos release: a new PC runs it
# from here, since a private fleet repository cannot be downloaded before you
# sign in. It needs --repo. A fleet repository also carries a copy as
# bin\bootstrap.windows.ps1 (written by `bun run stolos fleet init`,
# refreshed by `bun run stolos fleet upgrade`) with its repository filled in
# below ($DefaultRepo), for running again later. Both are the same script.
#
# Run it in PowerShell (not as Administrator), in one line, from the web:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/intellectual-frontiers/stolos/<tag>/bin/bootstrap.windows.ps1))) --repo <owner>/<fleet-repo>
#
# or from a downloaded copy:
#
#   powershell -ExecutionPolicy Bypass -File .\bootstrap.windows.ps1 --repo <owner>/<fleet-repo>
#
# Options (the same on every system; -Repo style works too):
#   --repo <owner/name>   the fleet repository on GitHub (or a Git URL or path)
#   --in <folder>         where the fleet goes (default: $HOME\fleet)
#   --destroy-existing    remove that folder first, then clone it fresh (it
#                         must be a checkout of the same repository; work not on
#                         GitHub yet is listed and needs the folder's name typed)
#   --no-shortcut         do not add the `stolos` shortcut
#   --runtime <bun|node>  the runtime (default: bun; node: Node 26, the backup)
#   --dry-run             say what each step would do; change nothing
#   --help                this text

# Native commands report through their exit codes; cmdlets that must not fail say -ErrorAction Stop.
# (Windows PowerShell 5.1 turns a native command's stderr into an error under 'Stop'.)
$ErrorActionPreference = 'Continue'

# The fleet's repository: empty in the engine's copy (then --repo is required).
$DefaultRepo = ""
# The pinned runtimes (src/archon/core/bun-pin.ts; the engine's tests keep them equal).
$BunVersion = "1.4.4"
$NodeVersion = "26.13.1"
# The SHA-256 of bun-<target>.zip, from Bun's release (commons pins.ttl, pmid:pin-bun).
$BunSha256 = @{
  'windows-x64'          = 'cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5'
  'windows-x64-baseline' = '0f20ce6674d4f2dbcc8c5d59fdf99f7ba45f8c3b367e0f5781cbfa30a1c78d99'
  'windows-aarch64'      = '2d57a0eec0cb44d95c918c3f9734f60455a1306ae5085d76fc68f44e3ee30d09'
}
# The SHA-256 of node-v<version>-<target>.zip, from Node's SHASUMS256.txt.
$NodeSha256 = @{
  'win-x64'   = 'e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7'
  'win-arm64' = '181ebe431b90787113a9e4fc80d38ce86d37888a353a0386de44d2872e48cb97'
}

$Repo = $DefaultRepo
$In = Join-Path $HOME "fleet"
$Destroy = $false
$Dry = $false
$Shortcut = $true
$Runtime = if ($env:STOLOS_RUNTIME) { $env:STOLOS_RUNTIME } else { 'bun' }

function Show-Usage {
  $d = if ($DefaultRepo) { " (default: $DefaultRepo)" } else { "" }
  Write-Host @"
Stolos bootstrap: Bun, Git, gh, your GitHub sign-in, and the fleet in one folder.

  bootstrap.windows.ps1 [--repo <owner/name>] [--in <folder>] [--destroy-existing]
                        [--no-shortcut] [--runtime <bun|node>] [--dry-run]

  --repo <owner/name>   the fleet repository$d
  --in <folder>         where it goes (default: `$HOME\fleet); already there: stolos update
  --destroy-existing    remove that folder first, then clone it fresh
  --no-shortcut         do not add the stolos shortcut to your PowerShell profile
  --runtime <bun|node>  the runtime (default: bun; node: Node $NodeVersion, the backup)
  --dry-run             say what each step would do; change nothing
"@
}

# A failure stops this script, never the PowerShell window it runs in (the one-line form runs
# inside your session, where `exit` would close it).
class BootstrapStop : System.Exception { BootstrapStop() : base('stolos bootstrap stopped') {} }

$failed = $false
try {

$rest = @($args)
$i = 0
while ($i -lt $rest.Count) {
  $a = "$($rest[$i])"; $i++
  $name = ($a.TrimStart('-').ToLower() -replace '=.*$', '') -replace '-', ''
  if ($name -in 'repo', 'in', 'runtime') {
    if ($a -match '=') { $v = $a.Substring($a.IndexOf('=') + 1) }
    elseif ($i -lt $rest.Count) { $v = "$($rest[$i])"; $i++ }
    else { Write-Host "$a needs a value (see --help)"; throw [BootstrapStop]::new() }
    if ($name -eq 'repo') { $Repo = $v } elseif ($name -eq 'in') { $In = $v } else { $Runtime = $v }
    continue
  }
  switch ($name) {
    'destroyexisting' { $Destroy = $true }
    'noshortcut' { $Shortcut = $false }
    'dryrun' { $Dry = $true }
    { $_ -in 'help', 'h', '?' } { Show-Usage; return }
    default { Write-Host "unknown option: $a (see --help)"; throw [BootstrapStop]::new() }
  }
}

# ---------------------------------------------------------------- output

function Ok($what, $msg) { Write-Host ("[ok] {0,-16} {1}" -f $what, $msg) }
function Todo($what, $msg) { Write-Host ("[..] {0,-16} {1}" -f $what, $msg) }
function Fail($what, $msg, $fix) {
  Write-Host ("[FAIL] {0,-14} {1}" -f $what, $msg) -ForegroundColor Red
  if ($fix) { Write-Host ("       {0,-14} fix: {1}" -f "", $fix) }
  throw [BootstrapStop]::new()
}
# Run a native command (or, --dry-run, only say it); fail on a non-zero exit.
function Act([string]$what, [string]$exe, [string[]]$argv) {
  if ($Dry) { Write-Host "       would run: $exe $($argv -join ' ')"; return }
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { Fail $what "$exe $($argv -join ' ') exited with $LASTEXITCODE" "read its output above; then run this again" }
}
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
# Programs installed a moment ago are on the saved PATH, not yet in this window's. The pinned
# runtimes' folders come first (an older Bun or Node elsewhere must not hide them), then this
# window's own PATH (what the caller added is kept), then the saved ones; each folder once.
function Update-Path {
  $dirs = @("$HOME\.bun\bin", "$HOME\.stolos\node") + @($env:Path -split ';') +
    @([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';') +
    @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';')
  $seen = @{}
  $keep = @()
  foreach ($d in $dirs) {
    if (-not $d) { continue }
    $key = $d.TrimEnd('\').ToLower()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $keep += $d
  }
  $env:Path = $keep -join ';'
}
function Winget-Install($what, $id) {
  if (-not (Has 'winget')) { Fail $what "winget is not here" "install App Installer from the Microsoft Store, then run this again" }
  Todo $what "installing (winget: $id)"
  Act $what 'winget' @('install', '--id', $id, '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements')
  Update-Path
}

if (-not $Repo) { Fail "Repository" "which fleet repository?" "add --repo <owner>/<name>" }
if ($Runtime -notin 'bun', 'node') { Fail "Runtime" "$Runtime is not bun or node" "--runtime bun (the default) or --runtime node" }
if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows -and -not $Dry) {
  Fail "System" "this is not Windows" "on Linux or macOS: bash bootstrap.sh"
}

# A GitHub repository is owner/name; anything else (a URL, a path) is cloned as given, without gh.
$GitHub = $false
if ($Repo -match '://|^[A-Za-z]:\\|^\.{0,2}[\\/]|@.+:') { $Url = $Repo }
elseif ($Repo -match '^[^/\s]+/[^/\s]+$') { $GitHub = $true; $Url = "https://github.com/$Repo.git" }
else { Fail "Repository" "$Repo is not <owner>/<name>" "for example --repo example/fleet" }

Write-Host "==> Stolos bootstrap: $Repo into $In (Windows)"
Update-Path

# Whether version $a is at least $b (dotted numbers).
function At-Least($a, $b) { [version]($a -replace '[^\d.].*$', '') -ge [version]$b }

# ---------------------------------------------------------------- 1. The runtime: Bun (or Node 26)

# The version a runtime reports, without a leading v or a suffix ("" when it is not here or cannot run).
# All of its output first, then the first line: Select-Object -First in the pipeline would stop the
# program early, and PowerShell 7 then reports an exit code that is not the program's.
function Version-Of($cmd) {
  if (-not (Has $cmd)) { return "" }
  try { $out = @(& $cmd --version 2>$null); $code = $LASTEXITCODE } catch { return "" }
  if ($code -ne 0 -or $out.Count -eq 0) { return "" }
  return ("$($out[0])".Trim() -replace '^v', '') -replace '-.*$', ''
}
# Whether this x64 processor has AVX2 (Bun's baseline build is for one without).
function Has-Avx2 {
  try {
    Add-Type -Namespace Stolos -Name Cpu -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint feature);' -ErrorAction Stop
    return [Stolos.Cpu]::IsProcessorFeaturePresent(40) # PF_AVX2_INSTRUCTIONS_AVAILABLE
  } catch { return $true }
}
# This PC's processor (ARM64 also where this PowerShell runs emulated as x64).
function Cpu-Arch {
  $a = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ($a -eq 'ARM64') { return 'arm64' }
  if ($a -eq 'AMD64') { return 'x64' }
  return $a
}
# Download $url into a new folder, kept only when its SHA-256 is $sum; the file's path.
function Fetch-Pinned($what, $url, $sum) {
  $dir = Join-Path ([IO.Path]::GetTempPath()) "stolos-$what-$PID"
  New-Item -ItemType Directory -Force $dir -ErrorAction Stop | Out-Null
  $file = Join-Path $dir ($url -replace '^.*/', '')
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $progress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file -ErrorAction Stop }
  catch { Fail $what "could not download $url ($($_.Exception.Message))" "check the network, then run this again" }
  finally { $ProgressPreference = $progress }
  $got = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLower()
  if ($got -ne $sum) {
    Remove-Item -Recurse -Force $dir
    Fail $what "$($url -replace '^.*/', '') is not the pinned one (SHA-256 $got, not $sum): nothing was unpacked" "run this again; if it says the same, tell the engine's maintainers"
  }
  return $file
}
# A folder on your own PATH (saved, for new windows) and on this window's.
function Add-UserPath($dir) {
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($user -split ';') -contains $dir)) {
    [Environment]::SetEnvironmentVariable('Path', ((@($dir) + @($user -split ';' | Where-Object { $_ })) -join ';'), 'User')
  }
  Update-Path
}

# The pinned Bun, into $HOME\.bun\bin; where there is none for this PC, Node instead.
function Install-Bun {
  $arch = Cpu-Arch
  $t = if ($arch -eq 'arm64') { 'windows-aarch64' } elseif ($arch -ne 'x64') { '' } elseif (Has-Avx2) { 'windows-x64' } else { 'windows-x64-baseline' }
  if (-not $t) { Todo "Bun" "no Bun is pinned for this processor ($arch): Node $NodeVersion instead"; return 'node' }
  $url = "https://github.com/oven-sh/bun/releases/download/bun-v$BunVersion/bun-$t.zip"
  Todo "Bun" "installing $BunVersion (bun-$t.zip, its SHA-256 checked, into $HOME\.bun\bin)"
  if ($Dry) {
    Write-Host "       would run: Invoke-WebRequest $url"
    Write-Host "       would check: SHA-256 $($BunSha256[$t]), then unzip bun.exe into $HOME\.bun\bin"
    return 'bun'
  }
  $zip = Fetch-Pinned "Bun" $url $BunSha256[$t]
  $dir = Split-Path $zip
  Expand-Archive -Path $zip -DestinationPath $dir -Force -ErrorAction Stop
  $bin = Join-Path $HOME '.bun\bin'
  New-Item -ItemType Directory -Force $bin -ErrorAction Stop | Out-Null
  Copy-Item -Force (Join-Path $dir "bun-$t\bun.exe") (Join-Path $bin 'bun.exe') -ErrorAction Stop
  Remove-Item -Recurse -Force $dir
  Add-UserPath $bin
  if ((Version-Of 'bun') -eq $BunVersion) { Ok "Bun" "$BunVersion ($bin\bun.exe)"; return 'bun' }
  Todo "Bun" "Bun $BunVersion does not run on this PC: Node $NodeVersion instead"
  return 'node'
}

# The pinned Node, into $HOME\.stolos\node.
function Install-Node {
  $t = if ((Cpu-Arch) -eq 'arm64') { 'win-arm64' } else { 'win-x64' }
  $base = "node-v$NodeVersion-$t"
  $url = "https://nodejs.org/dist/v$NodeVersion/$base.zip"
  $home2 = Join-Path $HOME '.stolos\node'
  Todo "Node" "installing $NodeVersion ($base.zip, its SHA-256 checked, into $home2)"
  if ($Dry) {
    Write-Host "       would run: Invoke-WebRequest $url"
    Write-Host "       would check: SHA-256 $($NodeSha256[$t]), then unzip it into $home2"
    return
  }
  $zip = Fetch-Pinned "Node" $url $NodeSha256[$t]
  $dir = Split-Path $zip
  Expand-Archive -Path $zip -DestinationPath $dir -Force -ErrorAction Stop
  if (Test-Path $home2) { Remove-Item -Recurse -Force $home2 -ErrorAction Stop }
  New-Item -ItemType Directory -Force (Split-Path $home2) -ErrorAction Stop | Out-Null
  Move-Item (Join-Path $dir $base) $home2 -ErrorAction Stop
  Remove-Item -Recurse -Force $dir
  Add-UserPath $home2
  if ((Version-Of 'node') -ne $NodeVersion) { Fail "Node" "Node $NodeVersion does not run on this PC" "install Node 26 yourself, then run this again" }
  Ok "Node" "$NodeVersion ($home2\node.exe)"
}

if ($Runtime -eq 'bun') {
  $have = Version-Of 'bun'
  if (-not $have) { $Runtime = Install-Bun }
  elseif (-not (At-Least $have $BunVersion)) {
    Todo "Bun" "$have is older than ${BunVersion}: installing the pinned one"
    $Runtime = Install-Bun
  }
  else { Ok "Bun" "$have (at least $BunVersion)" }
}
if ($Runtime -eq 'node') {
  $have = Version-Of 'node'
  if ($have -and (At-Least $have '26.0.0')) { Ok "Node" "$have (at least 26; Bun is the runtime of record)" }
  else { Install-Node }
}
# How the fleet's commands run: its package.json's script with Bun, its stolos.ts with Node.
$StolosCmd = if ($Runtime -eq 'bun') { 'bun run stolos' } else { 'node stolos.ts' }
function Invoke-Stolos([string[]]$argv) {
  if ($Runtime -eq 'bun') { & bun run stolos @argv } else { & node stolos.ts @argv }
}

# ---------------------------------------------------------------- 2. Git

if (Has 'git') { Ok "Git" (git --version) } else { Winget-Install "Git" "Git.Git" }

# ---------------------------------------------------------------- 3 and 4. gh, and the sign-in

if ($GitHub) {
  if (Has 'gh') { Ok "gh" (gh --version | Select-Object -First 1) } else { Winget-Install "gh" "GitHub.cli" }
  if (-not $Dry -and -not (Has 'gh')) { Fail "gh" "gh is still not on PATH" "open a new PowerShell window, then run this again" }
  $signedIn = $false
  if (Has 'gh') { gh auth status --hostname github.com *> $null; $signedIn = ($LASTEXITCODE -eq 0) }
  if ($signedIn) { Ok "GitHub" "signed in as $(gh api user --jq .login)" }
  else {
    Todo "GitHub" "signing in (your browser opens; paste the code it shows)"
    Act "GitHub" 'gh' @('auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https')
  }
  # Git uses gh's sign-in for github.com (idempotent).
  Act "GitHub" 'gh' @('auth', 'setup-git', '--hostname', 'github.com')
  if (-not $Dry) {
    gh repo view $Repo --json name *> $null
    if ($LASTEXITCODE -ne 0) { Fail "GitHub" "your GitHub account cannot see $Repo" "check the name, or ask its owner to add you" }
  }
}

# ---------------------------------------------------------------- 5. The fleet

function Norm($s) { ($s -replace '\.git[\\/]?$', '' -replace '[\\/]+$', '').ToLower() }
# Whether folder $dir is a checkout of the repository asked for.
function Same-Repo($dir) {
  $have = git -C $dir remote get-url origin 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $have) { return $false }
  if ($GitHub) { return (Norm $have) -match ("github\.com[:/]" + [regex]::Escape((Norm $Repo)) + '$') }
  if ((Test-Path $Url) -and (Test-Path $have)) { return (Resolve-Path $Url).Path -eq (Resolve-Path $have).Path }
  return (Norm $have) -eq (Norm $Url)
}
function Empty-Dir($dir) { (Test-Path $dir -PathType Container) -and -not (Get-ChildItem -Force $dir | Select-Object -First 1) }
# The fleet's engine, exactly as its bun.lock holds it (by Bun, which checks it, on either runtime).
function Install-Engine {
  if ($Dry) { Write-Host "       would run: cd $In; bun install --frozen-lockfile (when it has a package.json)"; return }
  if (-not (Test-Path (Join-Path $In 'package.json'))) { return }
  if (-not (Version-Of 'bun')) {
    Fail "Engine" "the engine is installed by Bun (it checks bun.lock), and Bun does not run here" "run this on a PC where Bun runs, or install Bun $BunVersion yourself"
  }
  Todo "Engine" "bun install --frozen-lockfile (exactly what bun.lock holds)"
  Push-Location $In
  try { bun install --frozen-lockfile; $code = $LASTEXITCODE } finally { Pop-Location }
  if ($code -ne 0) {
    Fail "Engine" "bun install --frozen-lockfile did not finish" "an integrity error means a download is not what bun.lock holds: do not regenerate bun.lock (bun run stolos explain E046-LOCK-INTEGRITY); otherwise check the network, then run this again"
  }
  Ok "Engine" "installed, as bun.lock holds it"
}
function Clone {
  Todo "Fleet" "cloning $Repo into $In"
  Act "Fleet" 'git' @('clone', $Url, $In)
  if (-not $Dry) { Ok "Fleet" $In }
  Install-Engine
}

if (-not (Test-Path $In) -or (Empty-Dir $In)) { Clone }
elseif (-not (Same-Repo $In)) {
  Fail "Fleet" "$In is there and is not a checkout of $Repo" "choose another folder: --in <folder>"
}
elseif ($Destroy) {
  $real = (Resolve-Path $In).Path.TrimEnd('\')
  if ($real -eq (Resolve-Path $HOME).Path.TrimEnd('\') -or $real -match '^[A-Za-z]:$') {
    Fail "Fleet" "refusing to remove $real" "choose the fleet's own folder: --in <folder>"
  }
  # Work that exists only here: edits, commits not on GitHub, stashes.
  $lost = @(git -C $In status --porcelain) + @(git -C $In log --branches --not --remotes --oneline) + @(git -C $In stash list) |
    Where-Object { $_ }
  if ($lost.Count) {
    Write-Host "These exist only in $In and would be lost:"
    $lost | ForEach-Object { Write-Host "    $_" }
    $leaf = Split-Path $real -Leaf
    if ($Dry) { Write-Host "       would ask you to type `"$leaf`" to remove it" }
    else {
      $answer = Read-Host "Type `"$leaf`" to remove it anyway"
      if ($answer -ne $leaf) { Fail "Fleet" "not removed (you typed `"$answer`")" "push or save that work first, then run this again" }
    }
  }
  Todo "Fleet" "removing $In (--destroy-existing)"
  if ($Dry) { Write-Host "       would run: Remove-Item -Recurse -Force $In" } else { Remove-Item -Recurse -Force $In -ErrorAction Stop }
  Clone
}
else {
  Todo "Fleet" "$In is there: bringing it up to date"
  if ($Dry) { Write-Host "       would run: cd $In; $StolosCmd update" }
  else {
    if (-not (Test-Path (Join-Path $In 'node_modules'))) { Install-Engine }
    Push-Location $In
    try { Invoke-Stolos @('update'); $code = $LASTEXITCODE } finally { Pop-Location }
    if ($code -ne 0) { Fail "Fleet" "$StolosCmd update did not finish" "read its output above; then run this again" }
  }
}

# ---------------------------------------------------------------- 6. The shortcut

if ($Shortcut) {
  $line = "function stolos { $StolosCmd @args } # stolos shortcut (bootstrap): in the fleet folder"
  $docs = [Environment]::GetFolderPath('MyDocuments')
  # Both editions' profile for every host: Windows PowerShell 5.1 and PowerShell 7.
  $profiles = @((Join-Path $docs 'WindowsPowerShell\profile.ps1'), (Join-Path $docs 'PowerShell\profile.ps1'))
  $added = @()
  foreach ($p in $profiles) {
    if ((Test-Path $p) -and (Select-String -Path $p -SimpleMatch '# stolos shortcut (bootstrap)' -Quiet)) { continue }
    if ($Dry) { Write-Host "       would add to ${p}: $line" }
    else {
      New-Item -ItemType Directory -Force (Split-Path $p) -ErrorAction Stop | Out-Null
      Add-Content -Path $p -Value "`r`n$line" -ErrorAction Stop
    }
    $added += $p
  }
  # A profile is a script: PowerShell runs it only when scripts may run.
  if ((Get-ExecutionPolicy) -in 'Restricted', 'AllSigned', 'Undefined') {
    if ($Dry) { Write-Host "       would run: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned" }
    else {
      try { Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force -ErrorAction Stop }
      catch { Write-Host "       could not set your execution policy ($($_.Exception.Message)); the shortcut needs it: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned" }
    }
  }
  $where = if ($added.Count) { "added to $($added -join ', '); " } else { "" }
  Ok "Shortcut" "${where}type stolos ... in $In (new windows)"
}

Write-Host ""
Write-Host "==> done. Next, in a new PowerShell window:"
Write-Host "    cd $In"
Write-Host "    $StolosCmd                        where you are, and the next step"
Write-Host "    first PC for this fleet:  $StolosCmd keys setup   (then the README's setup)"
Write-Host "    restoring a lost PC:      $StolosCmd vault restore <your backup ZIP>"

}
catch [BootstrapStop] { $failed = $true }
catch { Write-Host "[FAIL] $($_.Exception.Message)" -ForegroundColor Red; $failed = $true }
# Run as a file (-File): an exit code for the caller. Run in your session (the one-line form): just stop.
if ($failed -and $PSCommandPath) { exit 1 }
