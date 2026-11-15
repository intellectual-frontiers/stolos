# Spec 069 (CI, windows-latest, run as administrator): the Windows probe and integrate script for real:
# the probe's facts in both PowerShells, --discover (changes nothing), then --adopt (turns on OpenSSH
# Server, installs the probe, authorizes a test key) and the key used over SSH: it runs the probe and
# nothing else. Usage: pwsh -File tests/integrate/windows-check.ps1
$ErrorActionPreference = 'Stop'
$env:STOLOS_RAW = (Get-Location).Path
function Check($file, $kinds) {
  bun tests/integrate/check-code.ts $file windows @kinds
  if ($LASTEXITCODE) { Write-Host "---- $file"; Get-Content $file; throw "check-in code: $file" }
}

foreach ($shell in 'powershell', 'pwsh') {
  $f = & $shell -NoProfile -ExecutionPolicy Bypass -File bin/stolos-probe.ps1 facts
  if (-not ($f -match '^family=windows$')) { throw "$shell probe: no family=windows" }
  if (-not ($f -match '^firewall=(on|off)$')) { throw "$shell probe: no firewall" }
  Write-Host "$shell probe: ok"
}

& powershell -NoProfile -ExecutionPolicy Bypass -File bin/integrate.windows.ps1 --discover *> discover.txt
Check discover.txt @('discover')
if (Test-Path 'C:\ProgramData\stolos') { throw '--discover changed this PC' }

# Through Bun (node:child_process), so the passphrase is exactly empty (PowerShell 7 passes '""' as two quote characters).
bun -e "require('node:child_process').execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', process.env.TEMP + '/probe'])"
if (-not (Test-Path "$env:TEMP\probe")) { throw 'no test key' }
$pub = Get-Content "$env:TEMP\probe.pub"
# The probe's SHA-256 as the PC computes it (its text, UTF-8).
$sha = (bun -e "const t = require('node:fs').readFileSync('bin/stolos-probe.ps1', 'utf8').replace(/^\uFEFF/, ''); console.log(require('node:crypto').createHash('sha256').update(t).digest('hex'))").Trim()
& powershell -NoProfile -ExecutionPolicy Bypass -File bin/integrate.windows.ps1 --adopt --fleet ci --key "$pub" --probe-sha256 $sha --yes *> adopt.txt
Write-Host '---- the installed probe, run directly:'
& powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\ProgramData\stolos\stolos-probe.ps1' facts 2>&1 | Select-Object -First 12
Check adopt.txt @('adopt')

$o = @('-i', "$env:TEMP\probe", '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=NUL', '-o', 'BatchMode=yes', "$env:USERNAME@localhost")
$facts = ssh @o facts
if (-not ($facts -match '^family=windows$')) {
  Write-Host '---- administrators_authorized_keys:'; icacls.exe 'C:\ProgramData\ssh\administrators_authorized_keys'
  Get-Content 'C:\ProgramData\ssh\administrators_authorized_keys' | ForEach-Object { $_.Substring(0, [Math]::Min(120, $_.Length)) }
  Write-Host '---- sshd_config Match:'; Select-String -Path 'C:\ProgramData\ssh\sshd_config' -Pattern 'Match|AuthorizedKeysFile'
  Write-Host '---- ssh -v:'; ssh -v @o facts 2>&1 | Select-Object -Last 25
  Write-Host '---- OpenSSH log:'; Get-WinEvent -LogName 'OpenSSH/Operational' -MaxEvents 15 -ErrorAction SilentlyContinue | ForEach-Object { $_.Message }
  throw "the probe key did not run the probe: $facts"
}
$other = ssh @o whoami 2>&1
if ($other -match [regex]::Escape($env:USERNAME.ToLower())) { throw "the probe key ran another command: $other" }
Write-Host 'over SSH: the probe key runs the probe, and nothing else'

& powershell -NoProfile -ExecutionPolicy Bypass -File bin/integrate.windows.ps1 --undo --fleet ci --yes
if ((Get-Content 'C:\ProgramData\ssh\administrators_authorized_keys' -ErrorAction SilentlyContinue) -match 'stolos-probe@ci') { throw '--undo left the key' }
Write-Host 'integrate on Windows: every check passed'
