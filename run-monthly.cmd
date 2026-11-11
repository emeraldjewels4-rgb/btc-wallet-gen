@echo off
rem Monthly treasury roll-up for Slack, launched by Windows Task Scheduler.
rem It reads only refill-audit.jsonl, so there is no wallet list to configure.
rem Usage: run-monthly.cmd [WEBHOOK_FILE]
rem   WEBHOOK_FILE  optional path to a file holding the Slack webhook URL;
rem                 when omitted the URL comes from .env as before.
rem Log lines are timestamped in ISO/UTC, matching the node tools.
rem Output goes to treasury-monthly.log and node's exit code is passed back.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"

set "STAMP_FILE=%TEMP%\treasury-monthly-stamp.txt"
set "STAMP="
"%NODE%" -e "require('fs').writeFileSync(process.argv[1], new Date().toISOString())" "%STAMP_FILE%"
if exist "%STAMP_FILE%" set /p STAMP=<"%STAMP_FILE%"
del "%STAMP_FILE%"
if "!STAMP!"=="" set "STAMP=unknown"

if "%~1"=="" goto monthly_env
echo [!STAMP!] running monthly roll-up with a webhook file>>treasury-monthly.log
"%NODE%" --env-file=.env treasury-monthly.mjs --post --webhook-file "%~1" >>treasury-monthly.log 2>&1
goto monthly_done

:monthly_env
echo [!STAMP!] running monthly roll-up>>treasury-monthly.log
"%NODE%" --env-file=.env treasury-monthly.mjs --post >>treasury-monthly.log 2>&1

:monthly_done
set "CODE=!ERRORLEVEL!"
echo [!STAMP!] exit code !CODE!>>treasury-monthly.log
exit /b !CODE!
