# Stolos integrate for Windows (spec 069): run on a Windows PC or server to bring it into a fleet.
#
# You do not need to know the details: the person who runs your fleet gives you this
# command, already filled in. It tells you what it will do and asks once.
#
#   --discover   (the default) Change nothing: print this machine's facts as a check-in code.
#   --adopt      Let the fleet look at this machine (read only, never change it): turn on
#                Windows' own OpenSSH Server if it is off, install a small read-only script
#                (C:\ProgramData\stolos\stolos-probe.ps1), and allow the fleet's probe key to
#                run that script and nothing else. Needs "Run as administrator".
#   --osquery    With --adopt: install osquery (its official MSI).
#   --fleet <id> --key '<probe public key>' --engine <tag> --probe-sha256 <hash>
#                Filled in for you by: bun run stolos host integrate.
#   --dry-run    Say what it would do; change nothing.   --yes   Do not ask.
#   --undo       Remove what --adopt added.
#
# A Windows PC that should be a managed fleet workstation uses WSL: run bin/integrate.sh
# --workstation inside Ubuntu (WSL). At the end this prints one line, the check-in code:
# copy it into the Stolos Console (Add a machine). It holds only public facts.
$ErrorActionPreference = 'Stop'
$Discover = $false; $Adopt = $false; $Osq = $false; $Dry = $false; $Yes = $false; $Undo = $false
$Fleet = ''; $Key = ''; $Engine = 'main'; $ProbeSha = ''
$rest = @($args); $i = 0
while ($i -lt $rest.Count) {
  $a = "$($rest[$i])"; $i++
  $name = ($a.TrimStart('-').ToLower() -replace '=.*$', '') -replace '-', ''
  if ($name -in 'fleet', 'key', 'engine', 'probesha256') {
    if ($a -match '=') { $v = $a.Substring($a.IndexOf('=') + 1) } elseif ($i -lt $rest.Count) { $v = "$($rest[$i])"; $i++ } else { Write-Host "$a needs a value"; exit 2 }
    switch ($name) { 'fleet' { $Fleet = $v } 'key' { $Key = $v } 'engine' { $Engine = $v } 'probesha256' { $ProbeSha = $v.ToLower() } }
    continue
  }
  switch ($name) {
    'discover' { $Discover = $true } 'adopt' { $Adopt = $true } 'osquery' { $Osq = $true }
    'dryrun' { $Dry = $true } 'yes' { $Yes = $true } 'undo' { $Undo = $true }
    { $_ -in 'help', 'h', '?' } { Write-Host 'See the comments at the top of integrate.windows.ps1.'; exit 0 }
    default { Write-Host "unknown option: $a (try --help)"; exit 2 }
  }
}
if (-not ($Adopt -or $Osq -or $Undo)) { $Discover = $true }

# STOLOS_RAW: where the engine's files are (tests use a local folder).
$Raw = if ($env:STOLOS_RAW) { $env:STOLOS_RAW } else { "https://raw.githubusercontent.com/intellectual-frontiers/stolos/$Engine" }
function Get-Text($u) { if ($u -match '^[A-Za-z]:\\|^/') { Get-Content -Raw $u } else { (Invoke-WebRequest -UseBasicParsing $u).Content } }
function Die($m) { Write-Host "`nintegrate: $m" -ForegroundColor Red; exit 1 }
$Admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$Dir = 'C:\ProgramData\stolos'; $Probe = Join-Path $Dir 'stolos-probe.ps1'
$Auth = 'C:\ProgramData\ssh\administrators_authorized_keys'
$Me = $env:USERNAME
function Test-Ssh { $s = Get-Service sshd -ErrorAction SilentlyContinue; $s -and $s.Status -eq 'Running' }

if (($Adopt -or $Undo) -and -not $Fleet) { Die '--fleet is needed (bun run stolos host integrate fills it in)' }
if ($Adopt -and -not $Key) { Die '--key is needed for --adopt (bun run stolos host integrate fills it in)' }
if (($Adopt -or $Undo -or $Osq) -and -not $Admin) { Die 'this needs an administrator: right-click PowerShell, Run as administrator, and run the command again' }

$plan = @()
if ($Undo) { $plan += "remove $Probe and the stolos-probe@$Fleet line from $Auth" }
else {
  if ($Adopt -and -not (Test-Ssh)) { $plan += "turn on Windows' own OpenSSH Server, so the fleet can reach this PC" }
  if ($Adopt) { $plan += "install the read-only script $Probe (checked against the fleet's copy)" }
  if ($Adopt) { $plan += "allow the fleet's key to run that script, and nothing else, in $Auth" }
  if ($Osq -and -not (Test-Path (Join-Path $env:ProgramFiles 'osquery\osqueryi.exe'))) { $plan += 'install osquery from its maker (MSI)' }
}
Write-Host ''
Write-Host ("Stolos integrate{0}: {1} (Windows), as {2}" -f $(if ($Fleet) { " for the fleet $Fleet" } else { '' }), $env:COMPUTERNAME, $Me)
Write-Host ''
if (-not $plan.Count) { Write-Host 'Nothing on this PC will change: it only reads its facts.' }
else {
  Write-Host 'This will:'; $n = 0; foreach ($p in $plan) { $n++; Write-Host "  $n. $p" }
  Write-Host ''; Write-Host 'Nothing else changes. Undo --adopt any time with --undo.'
  if ($Dry) { Write-Host "`n(--dry-run: nothing was changed)"; exit 0 }
  if (-not $Yes) { $ans = Read-Host 'Go ahead? [y/N]'; if ($ans -notmatch '^(y|yes)$') { Write-Host 'Nothing was changed.'; exit 1 } }
}

function Set-AuthFile($lines) {
  New-Item -ItemType Directory -Force (Split-Path $Auth) | Out-Null
  Set-Content -Path $Auth -Value $lines -Encoding ascii
  # sshd reads this file only when Administrators and SYSTEM alone may change it.
  icacls.exe $Auth /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null
  # ... and only when Administrators (or SYSTEM) own it, not the person who ran this.
  $acl = Get-Acl $Auth
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  Set-Acl -Path $Auth -AclObject $acl
}
$keep = @(); if (Test-Path $Auth) { $keep = @(Get-Content $Auth | Where-Object { $_ -notmatch "stolos-probe@$([regex]::Escape($Fleet))$" }) }

if ($Undo) {
  Set-AuthFile $keep; Remove-Item -Force -ErrorAction SilentlyContinue $Probe
  Write-Host 'Done: the fleet can no longer look at this PC. Tell the person who runs your fleet (host release).'; exit 0
}
if ($Adopt) {
  if (-not (Test-Ssh)) {
    Write-Host 'Turning on OpenSSH Server ...'
    $cap = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
    if ($cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
    Set-Service sshd -StartupType Automatic; Start-Service sshd
    if (-not (Test-Ssh)) { Die 'OpenSSH Server did not start: Settings > System > Optional features > OpenSSH Server' }
  }
  New-Item -ItemType Directory -Force $Dir | Out-Null
  $text = Get-Text "$Raw/bin/stolos-probe.ps1"
  if ($ProbeSha) {
    $h = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($text))).Replace('-', '').ToLower()
    if ($h -ne $ProbeSha) { Die "the downloaded probe is not the fleet's copy (checksum differs): nothing was installed" }
  }
  Set-Content -Path $Probe -Value $text -Encoding utf8 -NoNewline
  # (OI)(CI): the probe inside inherits these, once the folder's own inheritance is removed.
  icacls.exe $Dir /inheritance:r /grant '*S-1-5-32-544:(OI)(CI)F' /grant '*S-1-5-18:(OI)(CI)F' /grant '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  $pub = (($Key -split '\s+')[0..1]) -join ' '
  # The same as "restrict", spelled out: Windows' OpenSSH refuses the connection on "restrict" (CI found it).
  $line = "command=""powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Probe"",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc $pub stolos-probe@$Fleet"
  Set-AuthFile ($keep + $line)
  Write-Host 'The read-only probe is installed, and only the fleet''s key may run it.'
}
if ($Osq -and -not (Test-Path (Join-Path $env:ProgramFiles 'osquery\osqueryi.exe'))) {
  Write-Host 'Installing osquery ...'
  $rel = (Invoke-RestMethod https://api.github.com/repos/osquery/osquery/releases/latest).tag_name
  $msi = Join-Path $env:TEMP "osquery-$rel.msi"
  Invoke-WebRequest -UseBasicParsing "https://github.com/osquery/osquery/releases/download/$rel/osquery-$rel.msi" -OutFile $msi
  Start-Process msiexec.exe -Wait -ArgumentList '/i', $msi, '/qn'
  Remove-Item -Force $msi
}

# ---------------------------------------------------------------- the check-in code
$facts = if (Test-Path $Probe) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Probe facts }
else { $t = Join-Path $env:TEMP "stolos-probe-$PID.ps1"; Set-Content -Path $t -Value (Get-Text "$Raw/bin/stolos-probe.ps1") -Encoding utf8; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $t facts; Remove-Item -Force $t }
$kinds = @(); if ($Discover) { $kinds += 'discover' }; if ($Adopt) { $kinds += 'adopt' }; if ($Osq) { $kinds += 'osquery' }
$addr = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object IPAddress)
$macs = @(Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object { $_.MacAddress.Replace('-', ':').ToLower() })
$lines = @('@checkin', 'v=1', "fleet=$Fleet", "kinds=$($kinds -join ' ')", "user=$Me", "hostname=$env:COMPUTERNAME", "addresses=$($addr -join ' ')", "macs=$($macs -join ' ')", '@hostkeys')
$n = 0; foreach ($f in Get-ChildItem 'C:\ProgramData\ssh\ssh_host_*_key.pub' -ErrorAction SilentlyContinue) { $n++; $lines += "$n=" + ((((Get-Content $f.FullName) -split '\s+')[0..1]) -join ' ') }
$text = (($lines + @($facts)) -join "`n") + "`n"
$code = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
Write-Host ''
Write-Host 'Done. Copy this line into the Stolos Console (Add a machine), or send it to'
Write-Host 'the person who runs your fleet. It holds only public facts about this PC:'
Write-Host ''
Write-Output "stolos1:$code"
Write-Host ''
