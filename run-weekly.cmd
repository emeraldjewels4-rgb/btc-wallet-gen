@echo off
rem Weekly treasury roll-up for Slack, launched by Windows Task Scheduler.
rem It reads only refill-audit.jsonl, so there is no wallet list to configure.
rem Afterwards it refreshes site/index.html and uploads it when .env.upload
rem exists; without that file the refresh is local and the task stays green.
rem Usage: run-weekly.cmd [WEBHOOK_FILE]
rem   WEBHOOK_FILE  optional path to a file holding the Slack webhook URL;
rem                 when omitted the URL comes from .env as before.
rem Log lines are timestamped in ISO/UTC, matching the node tools.
rem Output goes to treasury-weekly.log and node's exit code is passed back.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"

set "STAMP_FILE=%TEMP%\treasury-weekly-stamp.txt"
set "STAMP="
"%NODE%" -e "require('fs').writeFileSync(process.argv[1], new Date().toISOString())" "%STAMP_FILE%"
if exist "%STAMP_FILE%" set /p STAMP=<"%STAMP_FILE%"
del "%STAMP_FILE%"
if "!STAMP!"=="" set "STAMP=unknown"

if "%~1"=="" goto weekly_env
echo [!STAMP!] running weekly roll-up with a webhook file>>treasury-weekly.log
"%NODE%" --env-file=.env treasury-weekly.mjs --post --webhook-file "%~1" >>treasury-weekly.log 2>&1
goto weekly_done

:weekly_env
echo [!STAMP!] running weekly roll-up>>treasury-weekly.log
"%NODE%" --env-file=.env treasury-weekly.mjs --post >>treasury-weekly.log 2>&1

:weekly_done
set "CODE=!ERRORLEVEL!"
echo [!STAMP!] exit code !CODE!>>treasury-weekly.log

rem Refresh the public status page after the roll-up, then upload it. A missing
rem .env.upload is a clean skip; a publish failure after a good roll-up still
rem turns the task red so a broken SFTP login is not silently serving a stale page.
echo [!STAMP!] refreshing the status page>>treasury-weekly.log
"%NODE%" publish-status.mjs --live>>treasury-weekly.log 2>&1
set "PUBLISH=!ERRORLEVEL!"
echo [!STAMP!] publish exit code !PUBLISH!>>treasury-weekly.log
if "!CODE!"=="0" if not "!PUBLISH!"=="0" set "CODE=!PUBLISH!"
exit /b !CODE!
