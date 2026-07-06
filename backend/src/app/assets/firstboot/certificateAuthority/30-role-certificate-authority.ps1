<#
.SYNOPSIS
    Certificate-authority role first-boot script (Phase G template stub).

.DESCRIPTION
    Spawned as SYSTEM by FirstBoot.ps1 (the runner) in its own child process.
    Installs the AD CS role binaries and records a role marker, then exits.
    It does NOT reboot and does NOT configure the CA -- CA type/key/validity
    are per-topology input that arrives with the Phase E authoring rework;
    the runner owns the single reboot after all scripts succeed. Progress
    goes to stdout (captured by the runner into C:\Windows\Temp\firstboot.log);
    any failure throws and exits non-zero.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Output "Installing AD CS role binaries ..."
Install-WindowsFeature ADCS-Cert-Authority -IncludeManagementTools | Out-Null
Write-Output "AD CS role binaries installed."

Set-Content -Path 'C:\firstboot-role.txt' -Value 'certificateAuthority' -Encoding ascii
Write-Output "Role marker written: certificateAuthority"
