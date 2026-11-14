# Stolos bootstrap for Windows (spec 062).
#
# Makes this PC a Stolos controller: the PC you manage a fleet from. In order,
# each step checking first and doing nothing when it is already done (so
# running it again is always safe):
#
#   1. Deno, at least the engine's minimum version (Deno's official installer,
#      into %USERPROFILE%\.deno; no Administrator needed).
#   2. Git (winget: Git.Git).
#   3. gh, GitHub's command line (winget: GitHub.cli).
#   4. Your GitHub sign-in (gh auth login, in the browser), and Git told to use
#      it (gh auth setup-git): no SSH key or token to make by hand.
#   5. The fleet repository: cloned into --in (default $HOME\fleet) when it is
#      not there; brought up to date (deno task stolos update) when it is.
#   6. A shortcut: `stolos ...` for `deno task stolos ...`, in your PowerShell
#      profile (Windows PowerShell and PowerShell 7). PowerShell runs a profile
#      only when scripts may run, so this also sets your own execution policy
#      to RemoteSigned when it is Restricted. Skip both with --no-shortcut.
#
# This is the bootstrap, published with every Stolos release: a new PC runs it
# from here, since a private fleet repository cannot be downloaded before you
# sign in. It needs --repo. A fleet repository also carries a copy as
# bin\bootstrap.windows.ps1 (written by `deno task stolos fleet init`,
# refreshed by `deno task stolos fleet upgrade`) with its repository filled in
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
#   --dry-run             say what each step would do; change nothing
#   --help                this text

# Native commands report through their exit codes; cmdlets that must not fail say -ErrorAction Stop.
# (Windows PowerShell 5.1 turns a native command's stderr into an error under 'Stop'.)
$ErrorActionPreference = 'Continue'

# The fleet's repository: empty in the engine's copy (then --repo is required).
$DefaultRepo = ""
# The engine's minimum Deno (src/archon/update/operator.ts MIN_DENO); the engine's tests keep them equal.
$DenoMin = "2.9.6"

$Repo = $DefaultRepo
$In = Join-Path $HOME "fleet"
$Destroy = $false
$Dry = $false
$Shortcut = $true

function Show-Usage {
  $d = if ($DefaultRepo) { " (default: $DefaultRepo)" } else { "" }
  Write-Host @"
Stolos bootstrap: Deno, Git, gh, your GitHub sign-in, and the fleet in one folder.

  bootstrap.windows.ps1 [--repo <owner/name>] [--in <folder>] [--destroy-existing]
                        [--no-shortcut] [--dry-run]

  --repo <owner/name>   the fleet repository$d
  --in <folder>         where it goes (default: `$HOME\fleet); already there: stolos update
  --destroy-existing    remove that folder first, then clone it fresh
  --no-shortcut         do not add the stolos shortcut to your PowerShell profile
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
  if ($name -in 'repo', 'in') {
    if ($a -match '=') { $v = $a.Substring($a.IndexOf('=') + 1) }
    elseif ($i -lt $rest.Count) { $v = "$($rest[$i])"; $i++ }
    else { Write-Host "$a needs a value (see --help)"; throw [BootstrapStop]::new() }
    if ($name -eq 'repo') { $Repo = $v } else { $In = $v }
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
# Programs installed a moment ago are on the saved PATH, not yet in this window's.
function Update-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
    [Environment]::GetEnvironmentVariable('Path', 'User') + ";$HOME\.deno\bin"
}
function Winget-Install($what, $id) {
  if (-not (Has 'winget')) { Fail $what "winget is not here" "install App Installer from the Microsoft Store, then run this again" }
  Todo $what "installing (winget: $id)"
  Act $what 'winget' @('install', '--id', $id, '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements')
  Update-Path
}

if (-not $Repo) { Fail "Repository" "which fleet repository?" "add --repo <owner>/<name>" }
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

# ---------------------------------------------------------------- 1. Deno

$have = if (Has 'deno') { ((deno --version | Select-Object -First 1) -split ' ')[1] } else { "" }
if (-not $have) {
  Todo "Deno" "installing $DenoMin (Deno's official installer, into $HOME\.deno)"
  if ($Dry) { Write-Host "       would run: irm https://deno.land/install.ps1 (version v$DenoMin)" }
  else {
    & ([scriptblock]::Create((Invoke-RestMethod https://deno.land/install.ps1 -ErrorAction Stop))) "v$DenoMin"
    Update-Path
    Ok "Deno" (deno --version | Select-Object -First 1)
  }
}
elseif (-not (At-Least $have $DenoMin)) {
  Todo "Deno" "$have is older than ${DenoMin}: upgrading"
  Act "Deno" 'deno' @('upgrade', '--version', $DenoMin)
}
else { Ok "Deno" "$have (at least $DenoMin)" }

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
function Clone {
  Todo "Fleet" "cloning $Repo into $In"
  Act "Fleet" 'git' @('clone', $Url, $In)
  if (-not $Dry) { Ok "Fleet" $In }
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
  if ($Dry) { Write-Host "       would run: cd $In; deno task stolos update" }
  else {
    Push-Location $In
    try { deno task stolos update; $code = $LASTEXITCODE } finally { Pop-Location }
    if ($code -ne 0) { Fail "Fleet" "deno task stolos update did not finish" "read its output above; then run this again" }
  }
}

# ---------------------------------------------------------------- 6. The shortcut

if ($Shortcut) {
  $line = 'function stolos { deno task stolos @args } # stolos shortcut (bootstrap): in the fleet folder'
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
Write-Host "    deno task stolos                       where you are, and the next step"
Write-Host "    first PC for this fleet:  deno task stolos keys setup   (then the README's setup)"
Write-Host "    restoring a lost PC:      deno task stolos vault restore <your backup ZIP>"

}
catch [BootstrapStop] { $failed = $true }
catch { Write-Host "[FAIL] $($_.Exception.Message)" -ForegroundColor Red; $failed = $true }
# Run as a file (-File): an exit code for the caller. Run in your session (the one-line form): just stop.
if ($failed -and $PSCommandPath) { exit 1 }
