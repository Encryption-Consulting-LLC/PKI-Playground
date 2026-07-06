<#
.SYNOPSIS
    Web-server role first-boot script (Phase G template stub).

.DESCRIPTION
    Spawned as SYSTEM by FirstBoot.ps1 (the runner) in its own child process.
    Installs IIS and records a role marker, then exits. It does NOT reboot
    and does NOT bind certificates or publish CDP/AIA -- that is per-topology
    input that arrives with the Phase E authoring rework; the runner owns the
    single reboot after all scripts succeed. Progress goes to stdout (captured
    by the runner into C:\Windows\Temp\firstboot.log); any failure throws and
    exits non-zero.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Output "Installing IIS (Web-Server) role ..."
Install-WindowsFeature Web-Server -IncludeManagementTools | Out-Null
Write-Output "IIS role installed."

Set-Content -Path 'C:\firstboot-role.txt' -Value 'webServer' -Encoding ascii
Write-Output "Role marker written: webServer"
