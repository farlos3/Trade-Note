#requires -Version 5
<#
.SYNOPSIS
    Add this machine's current public IP to the MongoDB Atlas project IP access list.

.DESCRIPTION
    TradeNote connects to MongoDB Atlas, which only accepts connections from
    whitelisted IPs. Home / office IPs change, so this script:
      1. Looks up the current public IP.
      2. Removes stale entries this script added before (comment prefix match).
      3. Adds the current IP if it is not already whitelisted.

    Credentials are read from .env (ATLAS_PUBLIC_KEY / ATLAS_PRIVATE_KEY /
    ATLAS_PROJECT_ID) unless passed as parameters. Uses curl.exe (bundled with
    Windows) for HTTP Digest auth, which the Atlas Admin API requires.

.EXAMPLE
    .\scripts\update-atlas-ip.ps1
#>
[CmdletBinding()]
param(
    [string]$EnvFile,
    [string]$PublicKey,
    [string]$PrivateKey,
    [string]$ProjectId,
    [string]$Comment = "TradeNote auto"
)

$ErrorActionPreference = "Stop"

function Read-DotEnv {
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path $Path)) { return $map }
    foreach ($line in Get-Content -Path $Path -Encoding UTF8) {
        $t = $line.Trim()
        if ($t -eq "" -or $t.StartsWith("#")) { continue }
        $idx = $t.IndexOf("=")
        if ($idx -lt 1) { continue }
        $k = $t.Substring(0, $idx).Trim()
        $v = $t.Substring($idx + 1).Trim()
        if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
            $v = $v.Substring(1, $v.Length - 2)
        }
        $map[$k] = $v
    }
    return $map
}

function Get-PublicIP {
    $urls = @("https://api.ipify.org", "https://checkip.amazonaws.com", "https://ifconfig.me/ip")
    foreach ($u in $urls) {
        try {
            $ip = ([string](Invoke-RestMethod -Uri $u -TimeoutSec 15)).Trim()
            if ($ip -match '^\d{1,3}(\.\d{1,3}){3}$') { return $ip }
        } catch { }
    }
    throw "Could not determine public IP (all lookup services failed)."
}

function Invoke-Atlas {
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Url,
        [string]$Body
    )
    $tmp = $null
    $curlArgs = @("-sS", "--digest", "-u", $script:cred,
        "-H", $script:accept, "-H", "Content-Type: application/json",
        "-X", $Method, "-w", "`n%{http_code}")
    if ($Body) {
        $tmp = [System.IO.Path]::GetTempFileName()
        [System.IO.File]::WriteAllText($tmp, $Body, (New-Object System.Text.UTF8Encoding($false)))
        $curlArgs += @("--data", "@$tmp")
    }
    $curlArgs += $Url

    $raw = & curl.exe @curlArgs
    if ($tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }

    $text = ($raw -join "`n")
    $lines = $text -split "`n"
    $code = ($lines[-1]).Trim()
    if ($lines.Count -gt 1) {
        $bodyText = ($lines[0..($lines.Count - 2)] -join "`n")
    } else {
        $bodyText = ""
    }
    return [pscustomobject]@{ Code = $code; Body = $bodyText }
}

# --- Resolve credentials -----------------------------------------------------
if (-not $EnvFile) { $EnvFile = Join-Path (Split-Path -Parent $PSScriptRoot) ".env" }
$envMap = Read-DotEnv -Path $EnvFile

if (-not $PublicKey)  { $PublicKey  = $envMap["ATLAS_PUBLIC_KEY"] }
if (-not $PrivateKey) { $PrivateKey = $envMap["ATLAS_PRIVATE_KEY"] }
if (-not $ProjectId)  { $ProjectId  = $envMap["ATLAS_PROJECT_ID"] }

if ([string]::IsNullOrWhiteSpace($PublicKey) -or
    [string]::IsNullOrWhiteSpace($PrivateKey) -or
    [string]::IsNullOrWhiteSpace($ProjectId)) {
    Write-Warning "Atlas API not configured. Set ATLAS_PUBLIC_KEY / ATLAS_PRIVATE_KEY / ATLAS_PROJECT_ID in $EnvFile"
    Write-Warning "Skipping IP update. (Create a key in Atlas: Access Manager -> API Keys, role 'Project Network Access Manager'.)"
    exit 2
}

if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    throw "curl.exe not found. It ships with Windows 10/11 - check your PATH."
}

$base   = "https://cloud.mongodb.com/api/atlas/v2"
$accept = "Accept: application/vnd.atlas.2023-11-15+json"
$cred   = "${PublicKey}:${PrivateKey}"

# --- Do the work -------------------------------------------------------------
$ip = Get-PublicIP
Write-Host "Current public IP: $ip"

$get = Invoke-Atlas -Method GET -Url "$base/groups/$ProjectId/accessList?itemsPerPage=500"
if ($get.Code -notmatch '^2') {
    # Chicken-and-egg: the API KEY has its own access list, separate from the
    # database Network Access list this script manages. If the key is pinned to
    # an old IP, it can't be used to whitelist the new one.
    if ($get.Code -eq '403' -and $get.Body -match 'IP_ADDRESS_NOT_ON_ACCESS_LIST') {
        $o = $ip.Split('.')
        $ip16 = "$($o[0]).$($o[1]).0.0/16"
        $ip24 = "$($o[0]).$($o[1]).$($o[2]).0/24"
        Write-Host ""
        Write-Host "ERROR: Atlas rejected the API key itself from this IP ($ip)." -ForegroundColor Red
        Write-Host ""
        Write-Host "  This is the API KEY's own access list - NOT the database Network Access"
        Write-Host "  list that this script manages. They are two different lists."
        Write-Host ""
        Write-Host "  Fix it in Atlas: Access Manager -> API Keys -> (your key) -> Edit"
        Write-Host "                   -> step 2 'Private Key & Access List' -> Add Access List Entry"
        Write-Host "    * Click 'USE CURRENT IP ADDRESS' to unblock right now, then"
        Write-Host "    * add your ISP's range as CIDR so the key survives IP rotation:"
        Write-Host "        try  $ip16   (broader, fewer surprises)"
        Write-Host "        or   $ip24   (tighter, may break when the ISP moves you)"
        Write-Host "    Atlas refuses 0.0.0.0/0 on API key access lists by design - a range is"
        Write-Host "    the only way to cover a dynamic IP."
        Write-Host ""
        Write-Host "  Don't want to maintain this at all? Set the DATABASE Network Access to"
        Write-Host "  0.0.0.0/0 (allowed there, and what Render deployments need anyway), then"
        Write-Host "  run start.ps1 -SkipIp. The database stays protected by user/password + TLS."
        exit 3
    }
    Write-Warning "Atlas GET accessList failed (HTTP $($get.Code)): $($get.Body)"
    exit 1
}

$entries = @()
try {
    $parsed = $get.Body | ConvertFrom-Json
    if ($parsed.results) { $entries = @($parsed.results) }
} catch {
    Write-Warning "Could not parse Atlas response: $($_.Exception.Message)"
    exit 1
}

$already = $false
foreach ($e in $entries) {
    if ($e.ipAddress -eq $ip -or $e.cidrBlock -eq "$ip/32") { $already = $true }
}

# Clean up stale entries this script added for a previous (now different) IP.
foreach ($e in $entries) {
    if ($e.comment -and $e.comment.StartsWith($Comment)) {
        $entryVal = if ($e.ipAddress) { $e.ipAddress } else { $e.cidrBlock }
        if ($entryVal -and $entryVal -ne $ip -and $entryVal -ne "$ip/32") {
            $enc = [uri]::EscapeDataString($entryVal)
            $del = Invoke-Atlas -Method DELETE -Url "$base/groups/$ProjectId/accessList/$enc"
            Write-Host "Removed stale IP $entryVal (HTTP $($del.Code))"
        }
    }
}

if ($already) {
    Write-Host "IP $ip is already whitelisted. Nothing to do."
    exit 0
}

$stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
$body = "[{`"ipAddress`":`"$ip`",`"comment`":`"$Comment $stamp`"}]"
$post = Invoke-Atlas -Method POST -Url "$base/groups/$ProjectId/accessList" -Body $body
if ($post.Code -match '^2') {
    Write-Host "Whitelisted $ip in Atlas project $ProjectId." -ForegroundColor Green
    exit 0
} else {
    Write-Warning "Atlas POST accessList failed (HTTP $($post.Code)): $($post.Body)"
    exit 1
}
