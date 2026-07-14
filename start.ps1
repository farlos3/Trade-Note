#requires -Version 5
<#
.SYNOPSIS
    Start the whole TradeNote project.

.DESCRIPTION
    One command to bring the project up:
      1. Start the TradeNote app in Docker (dev / local / prod compose file).
      2. Wait until the web app answers on its port.
      3. Run the MT5 -> TradeNote sync once (emails a reminder if new deals).

    Atlas IP whitelisting is OPT-IN (-UpdateIp). The recommended setup is to set
    Atlas Network Access to 0.0.0.0/0 once, which never needs updating again (the
    database is still protected by its user/password + TLS, and Render needs it).

    Any step that is not applicable (Atlas keys missing, MT5 terminal closed,
    Python absent) is turned into a warning instead of aborting the whole run.

.PARAMETER Mode
    dev (default, hot-reload) | local (build, no hot-reload) | prod (published image).

.PARAMETER UpdateIp
    Whitelist this machine's public IP in Atlas before starting. Only needed if
    the Atlas Network Access list is NOT 0.0.0.0/0.

.PARAMETER SkipDocker / SkipSync
    Skip individual steps.

.PARAMETER IpOnly
    Only refresh the Atlas IP whitelist, then exit.

.EXAMPLE
    .\start.ps1
.EXAMPLE
    .\start.ps1 -Mode prod
.EXAMPLE
    .\start.ps1 -IpOnly
#>
[CmdletBinding()]
param(
    [ValidateSet("dev", "local", "prod")]
    [string]$Mode = "dev",
    [switch]$UpdateIp,
    [switch]$SkipIp,   # kept for compatibility (skipping is now the default)
    [switch]$SkipDocker,
    [switch]$SkipSync,
    [switch]$IpOnly
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }

function Read-DotEnv {
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path $Path)) { return $map }
    foreach ($line in Get-Content -Path $Path -Encoding UTF8) {
        $t = $line.Trim()
        if ($t -eq "" -or $t.StartsWith("#")) { continue }
        $idx = $t.IndexOf("=")
        if ($idx -lt 1) { continue }
        $map[$t.Substring(0, $idx).Trim()] = $t.Substring($idx + 1).Trim()
    }
    return $map
}

$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) {
    Write-Warning ".env not found. Copy .env.example -> .env and fill it in first."
}
$envMap = Read-DotEnv -Path $envFile

# 1. --- Atlas IP whitelist (opt-in) ------------------------------------------
# Off by default: the recommended setup is Atlas Network Access = 0.0.0.0/0,
# which never needs updating. Pass -UpdateIp if you keep a tight whitelist.
if (($UpdateIp -or $IpOnly) -and -not $SkipIp) {
    Section "Updating MongoDB Atlas IP access list"
    try {
        & "$root\scripts\update-atlas-ip.ps1" -EnvFile $envFile
        if ($LASTEXITCODE -eq 2) {
            Write-Warning "Atlas IP step skipped (API keys not configured)."
        } elseif ($LASTEXITCODE -eq 3) {
            Write-Warning "Atlas IP step blocked by the API key's own access list - see the fix above."
        } elseif ($LASTEXITCODE -ne 0) {
            Write-Warning "Atlas IP update failed (exit $LASTEXITCODE) - see the message above."
        }
    } catch {
        Write-Warning "Atlas IP update error: $($_.Exception.Message)"
    }
}

if ($IpOnly) { Write-Host "`nIP-only run complete." -ForegroundColor Green; return }

# 2. --- Docker: start the app ------------------------------------------------
$port = $envMap["TRADENOTE_PORT"]; if (-not $port) { $port = "8080" }
$appUrl = "http://localhost:$port"

switch ($Mode) {
    "dev"   { $composeFile = "docker-compose-dev.yml";   $build = $true }
    "local" { $composeFile = "docker-compose-local.yml"; $build = $true }
    "prod"  { $composeFile = "docker-compose.yml";       $build = $false }
}

if (-not $SkipDocker) {
    Section "Starting TradeNote (Docker, mode=$Mode)"

    docker info | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Docker does not appear to be running. Start Docker Desktop and re-run."
        return
    }

    $composeArgs = @("compose", "-f", $composeFile, "up", "-d")
    if ($build) { $composeArgs += "--build" }
    Write-Host "docker $($composeArgs -join ' ')"
    docker @composeArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Error "docker compose failed."
        return
    }

    # 3. --- Wait for the app ---
    Section "Waiting for TradeNote at $appUrl"
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        try {
            $r = Invoke-WebRequest -Uri $appUrl -TimeoutSec 5 -UseBasicParsing
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { $ready = $true; break }
        } catch { }
        Start-Sleep -Seconds 3
    }
    if ($ready) {
        Write-Host "TradeNote is up at $appUrl" -ForegroundColor Green
    } else {
        Write-Warning "TradeNote did not respond within ~2 min. Check logs: docker compose -f $composeFile logs -f tradenote"
    }
}

# 4. --- MT5 -> TradeNote sync (once) -----------------------------------------
if (-not $SkipSync) {
    Section "Running MT5 -> TradeNote sync (once)"
    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }
    if (-not $py) {
        Write-Warning "Python not found; skipping MT5 sync. Install Python and: pip install MetaTrader5 openpyxl requests"
    } else {
        & $py.Source "$root\mt5-sync\mt5_sync.py"
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "MT5 sync did not complete (exit $LASTEXITCODE). Make sure the MT5 terminal is open and logged in."
        }
    }
}

Section "Done"
Write-Host "App:   $appUrl"
Write-Host "Logs:  docker compose -f $composeFile logs -f tradenote" -ForegroundColor DarkGray
Write-Host "IP:    only needed if Atlas Network Access is not 0.0.0.0/0  ->  .\start.ps1 -UpdateIp" -ForegroundColor DarkGray
