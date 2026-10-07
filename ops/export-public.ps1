param(
    [Parameter(Mandatory = $true)][string]$PrivateRules,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
& python -X utf8 (Join-Path $PSScriptRoot 'public_source.py') export --private-rules $PrivateRules --output $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw 'Public export failed; do not publish the output.' }
