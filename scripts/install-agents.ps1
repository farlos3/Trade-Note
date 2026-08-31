<#
.SYNOPSIS
  Schedule the R2 backup and the MT5 sync on Windows.

.DESCRIPTION
  The Windows half of scripts/install-backup-agent.sh and
  mt5-sync/install-sync-agent.sh, which are macOS LaunchAgents and do nothing
  here. Without this, a Windows machine only ever backs up at the end of
  ./tradenote.sh start and during ./tradenote.sh stop -- so a day left running and then interrupted
  has no snapshot for any of it.

  That gap has teeth, because ./tradenote.sh start RESTORES from R2 before anything else
  and restore_from_r2.py DROPs each collection before writing it. Anything
  journalled since the last backup is gone at that point, not merely stale.

  Both jobs are cheap to run often. run-backup.sh compares a fingerprint of the
  database (per-collection counts + newest _updated_at) with the last successful
  backup and exits when they match, so an idle machine sends nothing to R2.
  r2-backup.sh separately refuses to upload an empty or unreadable database, so a
  bad moment cannot overwrite a good snapshot.

  The tasks run the same run-backup.sh / run-sync.sh the Mac schedules, through
  Git Bash, rather than reimplementing either in PowerShell -- one behaviour to
  reason about on both machines, and the logs land in the same files.

.PARAMETER BackupMinutes
  How often to check whether the database changed. Default 2.

.PARAMETER SyncMinutes
  How often to read MetaTrader 5. Default 1.

.PARAMETER Status
  Show whether the tasks exist, when they last ran and what they returned.

.PARAMETER Logs
  Tail both log files.

.PARAMETER Uninstall
  Remove both tasks.

.EXAMPLE
  .\scripts\install-agents.ps1
.EXAMPLE
  .\scripts\install-agents.ps1 -BackupMinutes 10
.EXAMPLE
  .\scripts\install-agents.ps1 -Status
.EXAMPLE
  .\scripts\install-agents.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [int]$BackupMinutes = 2,
    [int]$SyncMinutes = 1,
    [switch]$Status,
    [switch]$Logs,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$BackupTask = 'TradeNote R2 backup'
$SyncTask   = 'TradeNote MT5 sync'
$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

# Git Bash runs the scripts. Look where the installer puts it, then fall back to
# deriving it from git.exe on PATH, which covers a non-default install location.
function Find-Bash {
    $candidates = @(
        'C:\Program Files\Git\bin\bash.exe',
        'C:\Program Files (x86)\Git\bin\bash.exe',
        "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($git) {
        $bash = Join-Path (Split-Path (Split-Path $git.Source)) 'bin\bash.exe'
        if (Test-Path $bash) { return $bash }
    }
    return $null
}

# Windows paths mean nothing to bash; hand it the /c/... form it understands.
function ConvertTo-BashPath($winPath) {
    $p = $winPath -replace '\\', '/'
    if ($p -match '^([A-Za-z]):(.*)$') { return "/$($Matches[1].ToLower())$($Matches[2])" }
    return $p
}

# ---------------------------------------------------------------- status / logs
if ($Status) {
    foreach ($name in @($BackupTask, $SyncTask)) {
        $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if (-not $t) { Write-Host "$name : not installed" -ForegroundColor Yellow; continue }
        $i = Get-ScheduledTaskInfo -TaskName $name
        Write-Host "$name : $($t.State)"
        Write-Host "    last run : $($i.LastRunTime)"
        # 267009 is "currently running"; 0 is a clean exit.
        Write-Host "    last code: $($i.LastTaskResult)"
        Write-Host "    next run : $($i.NextRunTime)"
    }
    exit 0
}

if ($Logs) {
    foreach ($f in @("$RepoRoot\backup\logs\backup.log", "$RepoRoot\mt5-sync\logs\sync.log")) {
        Write-Host "`n=== $f ===" -ForegroundColor Cyan
        if (Test-Path $f) { Get-Content $f -Tail 20 } else { Write-Host '  (no log yet)' }
    }
    exit 0
}

if ($Uninstall) {
    foreach ($name in @($BackupTask, $SyncTask)) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Host "Removed: $name"
        } else {
            Write-Host "Not installed: $name"
        }
    }
    exit 0
}

# ---------------------------------------------------------------------- install
if ($BackupMinutes -lt 1 -or $SyncMinutes -lt 1) {
    Fail 'Intervals are in whole minutes and must be at least 1 (the Task Scheduler minimum).'
}

$bash = Find-Bash
if (-not $bash) {
    Fail @'
Git Bash not found. These jobs run the same shell scripts the Mac schedules, so
Git for Windows is required: https://git-scm.com/download/win
'@
}

$repoBash = ConvertTo-BashPath $RepoRoot
Write-Host "Repo   : $RepoRoot"
Write-Host "Bash   : $bash"

function Install-Job($name, $script, $minutes) {
    # -lc so the login profile sets PATH the way an interactive Git Bash would;
    # the scripts also add Docker's own directory themselves, since a task's
    # environment is thinner than a terminal's.
    $cmd = "cd '$repoBash' && ./$script"
    $action = New-ScheduledTaskAction -Execute $bash -Argument "-lc `"$cmd`"" -WorkingDirectory $RepoRoot

    # Repeat from now. -AtStartup would fire before Docker Desktop exists, and both
    # scripts already skip quietly when the database is unreachable.
    #
    # -RepetitionDuration is given explicitly: left out, some Windows builds treat
    # the repetition as one-shot, so the job runs once and the schedule silently
    # stops -- the exact failure this whole script exists to prevent. Ten years is
    # the usual stand-in for "indefinitely"; TimeSpan::MaxValue is rejected.
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes $minutes) `
        -RepetitionDuration (New-TimeSpan -Days 3650)

    # Docker Desktop lives in the interactive session, so the task has to run as
    # this user while logged on -- a SYSTEM task cannot see the daemon at all.
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

    # Hidden so a console does not flash every interval. No time limit: the
    # default kills a task after 3 days, which silently ends the schedule.
    $settings = New-ScheduledTaskSettingsSet -Hidden `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew

    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
    }
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Description "TradeNote: $script every $minutes minute(s)" | Out-Null
    Write-Host "Installed: $name  (every $minutes minute(s))" -ForegroundColor Green
}

Install-Job $BackupTask 'scripts/run-backup.sh' $BackupMinutes
Install-Job $SyncTask   'mt5-sync/run-sync.sh'  $SyncMinutes

Write-Host ''
Write-Host 'Both jobs skip quietly when Docker or MetaTrader 5 is not running, so'
Write-Host 'leaving them scheduled costs nothing while the stack is stopped.'
Write-Host ''
Write-Host '  .\scripts\install-agents.ps1 -Status     what the scheduler thinks'
Write-Host '  .\scripts\install-agents.ps1 -Logs       what the jobs actually did'
Write-Host '  .\scripts\install-agents.ps1 -Uninstall  remove both'
