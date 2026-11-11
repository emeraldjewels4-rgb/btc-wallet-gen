# Register (or refresh) the daily treasury summary task.
#
# One task, three daily triggers: 08:15 is the real run, 11:15 and 14:15 are
# retries. The summary's --state file records the posted day, so once the
# morning post succeeds the later triggers exit immediately; after a failed
# morning post they try again instead of the day being skipped.
#
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File .\register-summary.ps1
$ErrorActionPreference = "Stop"

$cmd = Join-Path $PSScriptRoot "run-summary.cmd"
if (-not (Test-Path $cmd)) {
  throw "run-summary.cmd not found next to this script ($cmd)"
}

$action = New-ScheduledTaskAction -Execute $cmd
$triggers = @(
  (New-ScheduledTaskTrigger -Daily -At "08:15"),
  (New-ScheduledTaskTrigger -Daily -At "11:15"),
  (New-ScheduledTaskTrigger -Daily -At "14:15")
)
# StartWhenAvailable covers a machine that was asleep or off at trigger time.
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
  -TaskName "TreasuryDailySummary" `
  -Action $action `
  -Trigger $triggers `
  -Settings $settings `
  -Principal $principal `
  -Force | Out-Null

$task = Get-ScheduledTask -TaskName "TreasuryDailySummary"
$info = Get-ScheduledTaskInfo -TaskName "TreasuryDailySummary"
"Registered {0} ({1})" -f $task.TaskName, $task.State
foreach ($trigger in $task.Triggers) {
  "  trigger {0}" -f $trigger.StartBoundary
}
"  next run {0}" -f $info.NextRunTime
