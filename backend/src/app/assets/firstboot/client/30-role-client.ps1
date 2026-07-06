<#
.SYNOPSIS
    Client role first-boot script (Phase G template stub).

.DESCRIPTION
    Spawned as SYSTEM by FirstBoot.ps1 (the runner) in its own child process.
    Clients need no role binaries -- this only records the role marker so the
    machine self-identifies. It does NOT reboot; the runner owns the single
    reboot after all scripts succeed.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Set-Content -Path 'C:\firstboot-role.txt' -Value 'client' -Encoding ascii
Write-Output "Role marker written: client"
