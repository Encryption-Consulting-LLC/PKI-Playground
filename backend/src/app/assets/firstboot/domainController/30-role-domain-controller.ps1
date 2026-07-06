<#
.SYNOPSIS
    Domain-controller role first-boot script (Phase G template stub).

.DESCRIPTION
    Spawned as SYSTEM by FirstBoot.ps1 (the runner) in its own child process.
    Installs the AD DS role binaries and records a role marker, then exits.
    It does NOT reboot and does NOT promote -- forest/domain promotion needs
    per-topology input that arrives with the Phase E authoring rework; the
    runner owns the single reboot after all scripts succeed. Progress goes to
    stdout (captured by the runner into C:\Windows\Temp\firstboot.log); any
    failure throws and exits non-zero.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Output "Installing AD DS role binaries ..."
Install-WindowsFeature AD-Domain-Services -IncludeManagementTools | Out-Null
Write-Output "AD DS role binaries installed."

Set-Content -Path 'C:\firstboot-role.txt' -Value 'domainController' -Encoding ascii
Write-Output "Role marker written: domainController"
