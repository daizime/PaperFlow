param(
  [Parameter(Mandatory = $true)][string]$TargetPath,
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][string]$ReleasePath,
  [ValidateRange(5, 60)][int]$HoldSeconds = 30
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$permittedRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot '.cache/library')) + [IO.Path]::DirectorySeparatorChar
foreach ($candidate in @($TargetPath, $ReadyPath, $ReleasePath)) {
  $absoluteCandidate = [IO.Path]::GetFullPath($candidate)
  if (-not $absoluteCandidate.StartsWith($permittedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Verification files must stay inside this workspace .cache/library directory.'
  }
}

$lockedFile = $null
try {
  $lockedFile = [IO.File]::Open($TargetPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
  $readyRecord = [ordered]@{
    mechanism = 'Windows FileStream FileShare.None'
    powershell_version = $PSVersionTable.PSVersion.ToString()
    powershell_edition = $PSVersionTable.PSEdition
    process_id = $PID
    target = [IO.Path]::GetFullPath($TargetPath)
    acquired_at = [DateTimeOffset]::Now.ToString('o')
  }
  $readyTemporary = $ReadyPath + '.tmp'
  $readyRecord | ConvertTo-Json | Set-Content -LiteralPath $readyTemporary -Encoding utf8
  Move-Item -LiteralPath $readyTemporary -Destination $ReadyPath -Force
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($HoldSeconds)
  while (-not (Test-Path -LiteralPath $ReleasePath)) {
    if ([DateTimeOffset]::UtcNow -gt $deadline) { throw 'Timed out waiting for verification release signal.' }
    Start-Sleep -Milliseconds 40
  }
  Write-Output 'Exclusive Windows file handle released by verification signal.'
} finally {
  if ($null -ne $lockedFile) { $lockedFile.Dispose() }
}
