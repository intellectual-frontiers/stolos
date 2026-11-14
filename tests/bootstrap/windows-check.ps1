# Spec 062: bootstrap.windows.ps1, run for real on a Windows runner (CI only).
# Deno and Git are already there; the repository is a local one, so no gh and
# no sign-in. Usage: <shell> -File tests/bootstrap/windows-check.ps1 <shell>
# where <shell> is pwsh (PowerShell 7) or powershell (Windows PowerShell 5.1).

# Continue, not Stop: Windows PowerShell 5.1 turns a native command's stderr (git clone's
# progress) into a fatal error under Stop. Each check throws on its own when it fails.
$ErrorActionPreference = 'Continue'
$shell = $args[0]
$script = Join-Path $PSScriptRoot '..\..\bin\bootstrap-example.windows.ps1' | Resolve-Path
$tmp = Join-Path ([IO.Path]::GetTempPath()) "stolos-boot-$shell-$PID"
$src = Join-Path $tmp 'src'
$fleet = Join-Path $tmp 'fleet'
New-Item -ItemType Directory -Force $src | Out-Null
git -C $src init -q -b main
Set-Content (Join-Path $src 'README.md') 'a fleet'
git -C $src add -A
git -C $src -c user.name=t -c user.email=t@example.invalid commit -q --no-gpg-sign -m 'a fleet'

function Boot([string[]]$argv) {
  $out = & $shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script @argv 2>&1 | Out-String
  return @{ code = $LASTEXITCODE; out = $out }
}
function Check($cond, $what, $out) {
  if (-not $cond) { Write-Host $out; throw "FAILED: $what" }
  Write-Host "ok: $what"
}

$r = Boot @('--dry-run')
Check ($r.code -eq 1 -and $r.out -match 'which fleet repository') 'no --repo: asks for it, exit 1' $r.out

$r = Boot @('--repo', $src, '--in', $fleet, '--dry-run')
Check ($r.code -eq 0 -and $r.out -match 'would run: git clone' -and -not (Test-Path $fleet)) '--dry-run changes nothing' $r.out

$r = Boot @('--repo', $src, '--in', $fleet, '--no-shortcut')
Check ($r.code -eq 0 -and (Test-Path (Join-Path $fleet 'README.md'))) 'a real clone' $r.out
Check ($r.out -match '\[ok\] Deno' -and $r.out -notmatch 'GitHub') 'Deno found; a local repository needs no gh' $r.out

$r = Boot @('-Repo', $src, '-In', $fleet, '-DryRun')
Check ($r.code -eq 0 -and $r.out -match 'bringing it up to date') 'already there: stolos update (PowerShell-style options too)' $r.out

New-Item (Join-Path $fleet '.git\old-checkout') | Out-Null
$r = Boot @('--repo', $src, '--in', $fleet, '--no-shortcut', '--destroy-existing')
Check ($r.code -eq 0 -and -not (Test-Path (Join-Path $fleet '.git\old-checkout'))) '--destroy-existing: a fresh clone' $r.out

Set-Content (Join-Path $fleet 'README.md') 'edited'
$r = Boot @('--repo', $src, '--in', $fleet, '--destroy-existing', '--dry-run')
Check ($r.out -match 'would be lost' -and $r.out -match 'README.md' -and $r.out -match 'would ask you to type') 'work only there: listed, confirmation asked' $r.out

$other = Join-Path $tmp 'other'
New-Item -ItemType Directory $other | Out-Null
Set-Content (Join-Path $other 'notes.txt') 'mine'
$r = Boot @('--repo', $src, '--in', $other, '--destroy-existing')
Check ($r.code -eq 1 -and (Test-Path (Join-Path $other 'notes.txt'))) 'another folder is never touched' $r.out

# The one-line form runs in the caller's session: a failure must not end that session.
$probe = "& ([scriptblock]::Create((Get-Content -Raw '$script'))) --dry-run; 'still here'"
$out = & $shell -NoProfile -NonInteractive -Command $probe 2>&1 | Out-String
Check ($out -match 'which fleet repository' -and $out -match 'still here') 'the one-line form never closes your window' $out

# The shortcut: both profiles, once.
$r = Boot @('--repo', $src, '--in', $fleet, '--dry-run')
Check ($r.out -match 'would add to .*profile\.ps1') 'the shortcut, by default' $r.out

Remove-Item -Recurse -Force $tmp
Write-Host "bootstrap.windows.ps1: every check passed ($shell)"
