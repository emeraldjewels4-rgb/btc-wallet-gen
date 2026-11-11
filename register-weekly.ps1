# Register (or refresh) the weekly treasury roll-up task.
#
# Mondays at 08:30, 12:30 and 15:30 local, with StartWhenAvailable so a missed run
# happens when the machine wakes. Only the 08:30 run is normally the real one:
# the roll-up's --state file records the posted window, so the lunchtime and
# afternoon triggers exit immediately once the week has posted and act as
# retries only if the morning run failed.
#
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File .\register-weekly.ps1
$ErrorActionPreference = "Stop"

$cmd = Join-Path $PSScriptRoot "run-weekly.cmd"
if (-not (Test-Path $cmd)) {
  throw "run-weekly.cmd not found next to this script ($cmd)"
}

$action = New-ScheduledTaskAction -Execute $cmd
# 08:30 is the real run; 12:30 and 15:30 are retries. The roll-up's --state file
# records the posted window, so the later triggers exit immediately once the
# week has posted and only do work after a failed morning run.
$triggers = @(
  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At "08:30"),
  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At "12:30"),
  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At "15:30")
)
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal `
  -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName "TreasuryWeeklyRollup" `
  -Action $action `
  -Trigger $triggers `
  -Settings $settings `
  -Principal $principal `
  -Force | Out-Null

$task = Get-ScheduledTask -TaskName "TreasuryWeeklyRollup"
$info = Get-ScheduledTaskInfo -TaskName "TreasuryWeeklyRollup"
"Registered {0} ({1})" -f $task.TaskName, $task.State
foreach ($t in $task.Triggers) {
  "  trigger {0}" -f $t.StartBoundary
}
"  next run {0}" -f $info.NextRunTime
