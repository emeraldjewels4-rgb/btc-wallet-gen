# Register (or refresh) the monthly treasury roll-up task.
#
# Runs on the 1st of each month at 09:00, 13:00 and 16:00 local. The 09:00 run is
# the real one; the later triggers only act if it failed, because the roll-up's
# --state file records the posted window. StartWhenAvailable covers a machine
# that was asleep or off at trigger time.
#
# New-ScheduledTaskTrigger has no -Monthly option, so this registers through the
# Task Scheduler COM API, which supports monthly triggers directly.
#
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File .\register-monthly.ps1
#       powershell ... -File .\register-monthly.ps1 -WebhookFile C:\path\webhook.txt
#
# -WebhookFile makes the task pass that path to run-monthly.cmd as its first
# argument, so the scheduled run posts through the file instead of
# SLACK_WEBHOOK_URL in .env.
param(
  [string]$WebhookFile = ""
)

$ErrorActionPreference = "Stop"

$cmd = Join-Path $PSScriptRoot "run-monthly.cmd"
if (-not (Test-Path $cmd)) {
  throw "run-monthly.cmd not found next to this script ($cmd)"
}

$service = New-Object -ComObject Schedule.Service
$service.Connect()
$root = $service.GetFolder("\")

$definition = $service.NewTask(0)
$definition.RegistrationInfo.Description = "Monthly treasury roll-up for Slack."
$definition.Settings.Enabled = $true
$definition.Settings.StartWhenAvailable = $true
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Settings.ExecutionTimeLimit = "PT1H"

$definition.Triggers.Clear()
foreach ($time in @("09:00", "13:00", "16:00")) {
  $trigger = $definition.Triggers.Create(4) # TASK_TRIGGER_MONTHLY
  $trigger.StartBoundary = ("2026-11-01T" + $time + ":00")
  $trigger.DaysOfMonth = "1"
  $trigger.MonthsOfYear = 4095 # every month (0x0FFF)
  $trigger.Enabled = $true
}

$action = $definition.Actions.Create(0) # TASK_ACTION_EXEC
$action.Path = $cmd
if ($WebhookFile) {
  if (-not (Test-Path $WebhookFile)) { throw "webhook file not found: $WebhookFile" }
  $action.Arguments = "--webhook-file `"$WebhookFile`""
}

# flags 6 = create or update, logon type 3 = interactive token (no password),
# so the task runs only while this user is logged on.
$userId = "{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME
$root.RegisterTaskDefinition("TreasuryMonthlyRollup", $definition, 6, $userId, $null, 3) | Out-Null

$task = Get-ScheduledTask -TaskName "TreasuryMonthlyRollup"
$info = Get-ScheduledTaskInfo -TaskName "TreasuryMonthlyRollup"
"Registered {0} ({1})" -f $task.TaskName, $task.State
foreach ($t in $task.Triggers) {
  "  trigger {0} day-of-month {1}" -f $t.StartBoundary, $t.DaysOfMonth
}
"  next run {0}" -f $info.NextRunTime
