param([ValidateSet('protect','unprotect')][string]$Action, [string]$KeyFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$allowedDirectory = [System.IO.Path]::GetFullPath('C:\Users\singi\.codex\secrets')
$resolvedFile = [System.IO.Path]::GetFullPath($KeyFile)
if ([System.IO.Path]::GetDirectoryName($resolvedFile) -ne $allowedDirectory) { throw 'Unexpected key directory' }
if ($Action -eq 'protect') {
    if (Test-Path -LiteralPath $resolvedFile) { throw 'Refusing to overwrite a key' }
    [System.IO.Directory]::CreateDirectory($allowedDirectory) | Out-Null
    $keyBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
    if ($keyBytes.Length -ne 32) { throw 'AES key must be 32 bytes' }
    $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect($keyBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [System.IO.File]::WriteAllBytes($resolvedFile, $protectedBytes)
    $keyAcl = New-Object System.Security.AccessControl.FileSecurity
    $keyAcl.SetAccessRuleProtection($true, $false)
    $keyAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'Allow')))
    $keyAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('SYSTEM', 'FullControl', 'Allow')))
    [System.IO.File]::SetAccessControl($resolvedFile, $keyAcl)
    [Array]::Clear($keyBytes, 0, $keyBytes.Length)
} else {
    $keyBytes = [System.Security.Cryptography.ProtectedData]::Unprotect([System.IO.File]::ReadAllBytes($resolvedFile), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($keyBytes))
    [Array]::Clear($keyBytes, 0, $keyBytes.Length)
}
