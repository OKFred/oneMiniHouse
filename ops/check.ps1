[CmdletBinding()]
param([switch]$Postgres)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Invoke-Check {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Check failed: $Program $($Arguments -join ' ') (exit $LASTEXITCODE)"
    }
}

Push-Location $projectRoot
$testContainer = $null
$previousPgContainer = $env:PG_TEST_CONTAINER
$env:PG_TEST_CONTAINER = $null
try {
    Invoke-Check -Program 'python' -Arguments @('-X', 'utf8', '-B', '-m', 'unittest', 'discover',
        '-s', 'ops', '-p', 'test_public_source.py')
    Invoke-Check -Program 'python' -Arguments @('-X', 'utf8', '-B', 'ops/public_source.py', 'scan')
    if ($Postgres) {
        # Reject remote Docker endpoints before creating the disposable fixture.
        $dockerEndpoint = if ($env:DOCKER_CONTEXT) {
            & docker context inspect $env:DOCKER_CONTEXT --format '{{.Endpoints.docker.Host}}'
            if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Docker context' }
        } elseif ($env:DOCKER_HOST) { $env:DOCKER_HOST } else {
            & docker context inspect --format '{{.Endpoints.docker.Host}}'
            if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Docker context' }
        }
        if ($dockerEndpoint -notmatch '^(unix://|npipe://)') {
            throw 'PostgreSQL regression requires a local Docker socket or named pipe'
        }
        $testContainer = 'one-minihouse-pg-' + [guid]::NewGuid().ToString('N') + '-test'
        Invoke-Check -Program 'docker' -Arguments @('run', '--detach', '--name', $testContainer,
            '--network', 'none', '--label', 'one-minihouse.purpose=regression',
            '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine')
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            & docker exec $testContainer pg_isready -U postgres *> $null
            if ($LASTEXITCODE -eq 0) { $ready = $true; break }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) { throw 'Disposable PostgreSQL did not become ready' }
        # Both fixtures use these unprivileged roles; create once before tests
        # execute concurrently so their IF NOT EXISTS checks cannot race.
        Invoke-Check -Program 'docker' -Arguments @('exec', $testContainer, 'psql', '-X', '-v',
            'ON_ERROR_STOP=1', '-U', 'postgres', '-c',
            'CREATE ROLE example_grafana NOLOGIN; CREATE ROLE example_ingestor NOLOGIN;')
        $env:PG_TEST_CONTAINER = $testContainer
    } elseif ($env:CI -eq 'true') {
        throw 'CI must invoke check.ps1 -Postgres so database regressions cannot be skipped'
    }
    foreach ($component in @('gateway', 'ingestor', 'ingestor/cloud')) {
        Write-Host "Checking $component"
        Invoke-Check -Program 'pnpm' -Arguments @('--dir', $component, 'check')
        Invoke-Check -Program 'pnpm' -Arguments @('--dir', $component, 'test')
    }

    # Compile source without generating __pycache__ or importing deployment scripts.
    $pythonCheck = @'
import ast
import subprocess
from pathlib import Path

listed = subprocess.check_output(
    ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z']
).decode('utf-8').split('\0')
files = sorted({p for p in listed if p.startswith('ops/') and p.endswith('.py') and Path(p).is_file()})
for name in files:
    source = Path(name).read_text(encoding='utf-8-sig')
    ast.parse(source, filename=name)
print(f'Python syntax: {len(files)} files passed')
'@
    Invoke-Check -Program 'python' -Arguments @('-c', $pythonCheck)
    Invoke-Check -Program 'python' -Arguments @('-B', '-m', 'unittest', 'discover', '-s', 'ops/server-health', '-p', 'test_*.py')
    Invoke-Check -Program 'python' -Arguments @('-B', '-m', 'unittest', 'discover', '-s', 'ops/linux-temperature', '-p', 'test_*.py')
    Invoke-Check -Program 'git' -Arguments @('diff', '--check')
    Invoke-Check -Program 'git' -Arguments @('diff', '--cached', '--check')
    if ($Postgres) {
        Write-Host 'Local checks and disposable PostgreSQL regressions passed. No live services were accessed.'
    } else {
        Write-Host 'Local checks passed. Use -Postgres to also run disposable PostgreSQL regressions.'
    }
}
finally {
    if ($testContainer) {
        & docker rm --force --volumes $testContainer
        if ($LASTEXITCODE -ne 0) { Write-Warning "Could not remove disposable container $testContainer" }
    }
    $env:PG_TEST_CONTAINER = $previousPgContainer
    Pop-Location
}
