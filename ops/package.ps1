param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\ingestor\evidence\release'),
    [string]$PrivateRules
)
$ErrorActionPreference = 'Stop'
$arguments = @('-X', 'utf8', (Join-Path $PSScriptRoot 'public_source.py'), 'package', '--output', $OutputDirectory)
if ($PrivateRules) { $arguments += @('--private-rules', $PrivateRules) }
& python @arguments
if ($LASTEXITCODE -ne 0) { throw 'Source packaging failed.' }
