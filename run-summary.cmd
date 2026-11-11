@echo off
rem Daily treasury summary for Slack, launched by Windows Task Scheduler.
rem Each non-comment line of summary-wallets.txt is an argument pair for
rem treasury-summary.mjs, e.g. "--btc mainnet:bc1q..." or "--evm 1:0x...".
rem Usage: run-summary.cmd [WEBHOOK_FILE]
rem   WEBHOOK_FILE  optional path to a file holding the Slack webhook URL;
rem                 when omitted the URL comes from .env as before.
rem Log lines are timestamped in ISO/UTC, matching the node tools. An empty
rem wallet list is a clean skip logged once per day, so the task does not report
rem a failure and the retries stay quiet.
rem Output goes to treasury-summary.log and node's exit code is passed back.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"

set "STAMP_FILE=%TEMP%\treasury-summary-stamp.txt"
set "STAMP="
"%NODE%" -e "require('fs').writeFileSync(process.argv[1], new Date().toISOString())" "%STAMP_FILE%"
if exist "%STAMP_FILE%" set /p STAMP=<"%STAMP_FILE%"
del "%STAMP_FILE%"
if "!STAMP!"=="" set "STAMP=unknown"

set "ARGS="
for /f "usebackq tokens=* eol=#" %%L in ("summary-wallets.txt") do (
  set "LINE=%%L"
  if not "!LINE!"=="" set "ARGS=!ARGS! !LINE!"
)

if not "!ARGS!"=="" goto summary_run

set "SKIP_MARK=.treasury-summary-skip-day.txt"
set "TODAY_FILE=%TEMP%\treasury-summary-today.txt"
set "TODAY="
"%NODE%" -e "require('fs').writeFileSync(process.argv[1], new Date().toISOString().slice(0,10))" "%TODAY_FILE%"
if exist "%TODAY_FILE%" set /p TODAY=<"%TODAY_FILE%"
del "%TODAY_FILE%"
if "!TODAY!"=="" set "TODAY=unknown"

set "LAST="
if exist "%SKIP_MARK%" set /p LAST=<"%SKIP_MARK%"
if not "!TODAY!"=="!LAST!" (
  echo [!STAMP!] no wallets in summary-wallets.txt - skipping without posting (add a "--evm CHAIN:ADDRESS" or "--btc NETWORK:ADDRESS" line to enable it)>>treasury-summary.log
  >"%SKIP_MARK%" echo !TODAY!
)
exit /b 0

:summary_run
if "%~1"=="" goto summary_env
echo [!STAMP!] running summary with a webhook file>>treasury-summary.log
"%NODE%" --env-file=.env treasury-summary.mjs !ARGS! --post --webhook-file "%~1" >>treasury-summary.log 2>&1
goto summary_done

:summary_env
echo [!STAMP!] running summary>>treasury-summary.log
"%NODE%" --env-file=.env treasury-summary.mjs !ARGS! --post >>treasury-summary.log 2>&1

:summary_done
set "CODE=!ERRORLEVEL!"
echo [!STAMP!] exit code !CODE!>>treasury-summary.log
exit /b !CODE!
