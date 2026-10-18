@echo off
setlocal
REM Copyright (c) 2025 Smart Site Team
REM SPDX-License-Identifier: Apache-2.0
REM https://smartsite.top/
REM Contact: zkxxa@qq.com, zcwebms@gmail.com
REM
REM Start rtdb-server with the shared demo configuration, or run the demo client in
REM performance mode against a server that is ALREADY running.
REM
REM Config: src\packages\demo\conf\rtdb-server.json
REM Data:   src\packages\demo\data (created on first start, gitignored)
REM Token:  src\packages\demo\conf\rtdb.token (created on first start, gitignored)
REM
REM Environment variables (RTDB_PORT, RTDB_DATA_DIR, RTDB_AUTH_ENABLED, ...) still
REM override values from the config file.
REM
REM Usage:
REM   bin\start-demo-server.bat                        Start the server in this window
REM   bin\start-demo-server.bat help                   Show this help
REM   bin\start-demo-server.bat bench <pts/s> <seconds> [client options]
REM                                                    Load client only: rtdb-server must
REM                                                    already be running (started manually,
REM                                                    in another window or by a service)
REM   bin\start-demo-server.bat vars <pts/s> <seconds> [client options]
REM                                                    Variable-count ladder: runs the bench for
REM                                                    1000 / 3000 / 6000 / 10000 metrics, one
REM                                                    database per point (perf_vars_<count>)
REM   bin\start-demo-server.bat remote [host[:port] or url] [client options]
REM                                                    Remote smoke test against the published
REM                                                    instance (default URL
REM                                                    https://smartsite.top:8081): writes one
REM                                                    simulated batch, verifies it, then exits.
REM                                                    An optional positional target accepts
REM                                                    "smartsite.top:8081" (https is assumed)
REM                                                    or a full http(s):// URL; RTDB_REMOTE_URL
REM                                                    and RTDB_REMOTE_DB (default
REM                                                    smart_site_remote) also override.
REM                                                    Pass --duration / --rate to stream instead.
REM
REM                                                    Token order: RTDB_TOKEN (environment) ->
REM                                                    bin\rtdb.remote.token (gitignored) ->
REM                                                    a "demo-remote" API token (role=write)
REM                                                    minted after signing in with
REM                                                    RTDB_DEMO_USER / RTDB_DEMO_PASSWORD
REM                                                    (default admin / ss-rtdb); the minted
REM                                                    token is cached for later runs.
REM
REM Examples:
REM   window 1: bin\start-demo-server.bat
REM   window 2: bin\start-demo-server.bat bench 20000 300000  --metrics 10000 --token-file rtdb.token

REM   window 2: bin\start-demo-server.bat bench 20000 30 --db perf_demo --interval 500
REM   window 2: bin\start-demo-server.bat bench 5000 60 --points-per-tick 5000
REM   window 2: bin\start-demo-server.bat bench 200000 60 --metrics 10000
REM   window 2: bin\start-demo-server.bat vars 50000 60
REM
REM   bin\start-demo-server.bat remote                       One batch + verify (smoke test)
REM   bin\start-demo-server.bat remote smartsite.top:8081 --duration 60 --interval 1000
REM
REM The load client sends "rate * interval / 1000" points per batch: with the
REM default 1000 ms sampling interval, "--rate 20000" means 20000 points per batch
REM (one batch per second). Extra options are forwarded to the client unchanged.
REM
REM "--metrics <n>" scales the simulated variable count: the 44-tag catalog is
REM replicated with a "#k" metric-name suffix (10000 metrics = 44 tags x 228
REM copies), which widens the per-batch capacity to "metrics x interval" points.
REM "vars" runs the ladder 1000 / 3000 / 6000 / 10000 and keeps every point in
REM its own database so the results stay comparable.

set "SCRIPT_DIR=%~dp0"
set "SRC_DIR=%SCRIPT_DIR%..\src"
set "CONFIG_FILE=%SRC_DIR%\packages\demo\conf\rtdb-server.json"
set "SERVER_ENTRY=packages\server\src\main.ts"
set "CLIENT_ENTRY=packages\demo\client-smart-site\src\main.ts"

set "PORT=6180"
if defined RTDB_PORT set "PORT=%RTDB_PORT%"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH. Install Node 24 or newer.
  exit /b 1
)

set "ACTION=%~1"
if "%ACTION%"=="" goto check_files
if /I "%ACTION%"=="help" goto usage
if /I "%ACTION%"=="-h" goto usage
if /I "%ACTION%"=="--help" goto usage
if /I "%ACTION%"=="bench" goto prepare_bench
if /I "%ACTION%"=="vars" goto prepare_bench
if /I "%ACTION%"=="remote" goto prepare_remote

echo [ERROR] Unknown action: %ACTION%
call :print_short_usage
exit /b 1

:prepare_bench
shift
set "RATE=%~1"
if "%RATE%"=="" goto bench_usage
shift
set "SECONDS=%~1"
if "%SECONDS%"=="" goto bench_usage
shift
set "EXTRA="
:collect_extra
if "%~1"=="" goto check_files
set "EXTRA=%EXTRA% %1"
shift
goto collect_extra

:prepare_remote
shift
REM Optional positional target: "host[:port]" or a full "http(s)://host[:port]".
if "%~1"=="" goto remote_setup
set "REMOTE_TARGET=%~1"
if "%REMOTE_TARGET:~0,2%"=="--" goto remote_setup
set "RTDB_REMOTE_URL=%REMOTE_TARGET%"
shift

:remote_setup
if not defined RTDB_REMOTE_URL set "RTDB_REMOTE_URL=https://smartsite.top:8081"
if not defined RTDB_REMOTE_DB set "RTDB_REMOTE_DB=smart_site_remote"
REM A bare host[:port] defaults to https; the client requires an explicit scheme.
echo %RTDB_REMOTE_URL% | findstr /I /C:"http://" /C:"https://" >nul 2>nul
if errorlevel 1 set "RTDB_REMOTE_URL=https://%RTDB_REMOTE_URL%"
set "EXTRA="
:collect_remote_extra
if "%~1"=="" goto check_files
set "EXTRA=%EXTRA% %1"
shift
goto collect_remote_extra

:check_files
if /I "%ACTION%"=="bench" goto check_bench_files
if /I "%ACTION%"=="vars" goto check_bench_files
if /I "%ACTION%"=="remote" goto check_bench_files
if not exist "%CONFIG_FILE%" (
  echo [ERROR] Demo server config not found: "%CONFIG_FILE%"
  exit /b 1
)
if not exist "%SRC_DIR%\%SERVER_ENTRY%" (
  echo [ERROR] rtdb-server entry not found: "%SRC_DIR%\%SERVER_ENTRY%"
  exit /b 1
)
goto enter_src

:check_bench_files
if not exist "%SRC_DIR%\%CLIENT_ENTRY%" (
  echo [ERROR] Demo client entry not found: "%SRC_DIR%\%CLIENT_ENTRY%"
  exit /b 1
)

:enter_src
pushd "%SRC_DIR%" >nul
if errorlevel 1 (
  echo [ERROR] Cannot enter "%SRC_DIR%"
  exit /b 1
)

set "RTDB_CONFIG=%CONFIG_FILE%"

set "URL_ARG="
if defined RTDB_PORT set "URL_ARG=--url http://127.0.0.1:%RTDB_PORT%"

if /I "%ACTION%"=="bench" goto bench_start
if /I "%ACTION%"=="vars" goto vars_start
if /I "%ACTION%"=="remote" goto remote_start
goto server_foreground

:server_foreground
echo [demo] mode   : server (this window)
echo [demo] config : %RTDB_CONFIG%
echo [demo] data   : %SRC_DIR%\packages\demo\data
echo [demo] token  : %SRC_DIR%\packages\demo\conf\rtdb.token
echo [demo] console: http://127.0.0.1:%PORT%/admin/  (RTDB_PORT overrides the port)
echo.

node "%SERVER_ENTRY%"
set "CODE=%ERRORLEVEL%"
goto finish

:remote_start
echo [demo] mode   : remote smoke test (no local server is started)
echo [demo] target : %RTDB_REMOTE_URL%
echo [demo] db     : %RTDB_REMOTE_DB%
if not "%EXTRA%"=="" echo [demo] options:%EXTRA%
echo.

call :remote_auth
if errorlevel 1 (
  set "CODE=1"
  goto remote_done
)

REM Default is one batch plus verification; switch to streaming when the caller asked for it.
set "RUN_MODE=--once --verify"
set "RESULT_LABEL=remote smoke test"
echo %EXTRA% | findstr /I /C:"--duration" /C:"--rate" /C:"--points-per-tick" /C:"--total-points" /C:"--once" /C:"--dry-run" /C:"--list" >nul 2>nul
if not errorlevel 1 (
  set "RUN_MODE=--verify"
  set "RESULT_LABEL=remote run"
)

set /a ATTEMPT=0
:remote_attempt
set /a ATTEMPT+=1
node "%CLIENT_ENTRY%" --url %RTDB_REMOTE_URL% --db %RTDB_REMOTE_DB% %RUN_MODE% %TOKEN_ARG% %EXTRA%
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="3" goto remote_done
if %ATTEMPT% GEQ 2 goto remote_done
echo.
echo [demo] remote run failed (attempt %ATTEMPT%/2); retrying in 3 s ...
REM ping is used instead of timeout: timeout aborts when stdin is redirected (CI / piped output).
ping -n 4 127.0.0.1 >nul
goto remote_attempt

:remote_done
echo.
if "%CODE%"=="0" (
  echo [demo] %RESULT_LABEL% PASSED: simulated data was written to %RTDB_REMOTE_DB% and verified.
) else if "%CODE%"=="2" (
  echo [demo] %RESULT_LABEL% FAILED: verification did not match the written data.
) else if "%CODE%"=="3" (
  echo [demo] remote run failed: endpoint unreachable or credentials rejected
  echo [demo] check the endpoint first: %RTDB_REMOTE_URL%/healthz
  echo [demo] if this run reused a cached token, delete "%SCRIPT_DIR%rtdb.remote.token" and retry
) else (
  echo [demo] remote run finished with exit code %CODE%.
  echo [demo] hint: the target address goes right after "remote", for example
  echo          bin\start-demo-server.bat remote smartsite.top:8081 --duration 60
)
goto finish

:remote_auth
REM Resolve the Bearer token for the published instance; sets TOKEN_ARG when a file is used.
set "TOKEN_ARG="
echo %EXTRA% | findstr /I /C:"--token" >nul 2>nul
if not errorlevel 1 (
  echo [demo] token  : provided on the command line
  exit /b 0
)
if defined RTDB_TOKEN (
  echo [demo] token  : RTDB_TOKEN
  exit /b 0
)
if exist "%SCRIPT_DIR%rtdb.remote.token" (
  set "TOKEN_ARG=--token-file "%SCRIPT_DIR%rtdb.remote.token""
  echo [demo] token  : %SCRIPT_DIR%rtdb.remote.token
  exit /b 0
)

set "DEMO_USER=admin"
if defined RTDB_DEMO_USER set "DEMO_USER=%RTDB_DEMO_USER%"
set "DEMO_PASS=ss-rtdb"
if defined RTDB_DEMO_PASSWORD set "DEMO_PASS=%RTDB_DEMO_PASSWORD%"
set "TOKEN_TMP=%TEMP%\ss-rtdb-remote-token.txt"
del /f /q "%TOKEN_TMP%" >nul 2>nul
echo [demo] token  : signing in as %DEMO_USER% and minting a "demo-remote" token ...
REM A console-login token is revoked by the next sign-in of the same user (single-session
REM semantics), which kills streams longer than a minute whenever the console is used in
REM parallel. Mint a normal API token instead (role=write, no expiry): sign-ins never revoke
REM it. It is cached in bin\rtdb.remote.token (covered by the *.token gitignore) for later runs.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $b=ConvertTo-Json -InputObject (New-Object PSObject -Property @{username='%DEMO_USER%';password='%DEMO_PASS%'}) -Compress; $login=Invoke-RestMethod -Uri '%RTDB_REMOTE_URL%/api/v1/auth/login' -Method Post -ContentType 'application/json' -Body $b -TimeoutSec 20; $tok=$login.token; try { $h=@{Authorization=('Bearer '+$login.token)}; $nb=ConvertTo-Json -InputObject (New-Object PSObject -Property @{user='%DEMO_USER%';role='write';label='demo-remote'}) -Compress; $mint=Invoke-RestMethod -Uri '%RTDB_REMOTE_URL%/api/v1/admin/tokens' -Method Post -Headers $h -ContentType 'application/json' -Body $nb -TimeoutSec 20; $tok=$mint.token; try { [IO.File]::WriteAllText('%SCRIPT_DIR%rtdb.remote.token', $tok) } catch {} } catch {}; [IO.File]::WriteAllText('%TOKEN_TMP%', $tok)" >nul 2>nul
if errorlevel 1 goto remote_auth_failed
if not exist "%TOKEN_TMP%" goto remote_auth_failed
set "RTDB_TOKEN="
set /p RTDB_TOKEN=<"%TOKEN_TMP%"
del /f /q "%TOKEN_TMP%" >nul 2>nul
if not defined RTDB_TOKEN goto remote_auth_failed
if exist "%SCRIPT_DIR%rtdb.remote.token" (
  echo [demo] token  : saved to %SCRIPT_DIR%rtdb.remote.token (reused by later runs^)
) else (
  echo [demo] token  : session token only - a later sign-in of %DEMO_USER% revokes it
)
exit /b 0

:remote_auth_failed
echo [ERROR] Remote sign-in failed: %RTDB_REMOTE_URL%/api/v1/auth/login
echo         Provide a token instead:
echo           set RTDB_TOKEN=^<token^>
echo           bin\start-demo-server.bat remote --token ^<token^>
echo         The static server token is /home/ss-rtdb/rtdb.token on the host.
exit /b 1

:bench_start
set "VARS="
set "DB_NAME="
call :client_run
goto bench_done

:vars_start
echo [demo] mode   : vars (variable-count ladder 1000 / 3000 / 6000 / 10000)
echo [demo] server : http://127.0.0.1:%PORT%  (must already be running)
echo [demo] target : %RATE% points/s for %SECONDS% s per point
if not "%EXTRA%"=="" echo [demo] options: %EXTRA%
echo.
for %%V in (1000 3000 6000 10000) do call :vars_one %%V
goto vars_done

:vars_one
set "VARS=%~1"
set "DB_NAME=perf_vars_%VARS%"
call :client_run
echo [demo] vars %VARS% finished with exit code %CODE% (db %DB_NAME%)
echo.
goto :EOF

:client_run
REM Shared load-client run used by "bench" and "vars". Input: RATE, SECONDS, EXTRA and,
REM for the ladder, VARS (metric count) and DB_NAME (per-point database). Sets CODE.
echo [demo] mode   : bench (load client only, no server is started)
echo [demo] server : http://127.0.0.1:%PORT%  (must already be running)
echo [demo] target : %RATE% points/s for %SECONDS% s
if defined VARS echo [demo] metrics: %VARS% variables (db %DB_NAME%)
if not "%EXTRA%"=="" echo [demo] options: %EXTRA%
echo.

REM The server creates the token file on its own start; the client resolves its token
REM once before the first request, so wait for the file instead of racing against it.
set "TOKEN_FILE=%SRC_DIR%\packages\demo\conf\rtdb.token"
set /a WAIT=0
:wait_token
if exist "%TOKEN_FILE%" goto run_client
set /a WAIT+=1
if %WAIT% GEQ 10 goto token_timeout
timeout /t 1 /nobreak >nul
goto wait_token

:token_timeout
echo [demo] token file not found after 10 s: %TOKEN_FILE%
echo [demo] continuing without it (authentication may be disabled, or the server is down).
echo.

:run_client
set /a ATTEMPT=0
set "METRICS_ARG="
if defined VARS set "METRICS_ARG=--metrics %VARS%"
set "DB_ARG="
if defined DB_NAME set "DB_ARG=--db %DB_NAME%"
:bench_attempt
set /a ATTEMPT+=1
node "%CLIENT_ENTRY%" --rate %RATE% --duration %SECONDS% --log-every 1 %METRICS_ARG% %DB_ARG% %URL_ARG%%EXTRA%
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="3" goto client_run_done
if %ATTEMPT% GEQ 3 goto client_run_done
echo.
echo [demo] rtdb-server not reachable yet (attempt %ATTEMPT%/3); retrying in 3 s ...
timeout /t 3 /nobreak >nul
goto bench_attempt

:client_run_done
goto :EOF

:bench_done
echo.
if "%CODE%"=="3" (
  echo [demo] the load client could not reach http://127.0.0.1:%PORT%
  echo [demo] start rtdb-server first, for example: bin\start-demo-server.bat
) else (
  echo [demo] benchmark finished with exit code %CODE%.
)
goto finish

:vars_done
echo.
echo [demo] variable-count ladder finished: 1000 / 3000 / 6000 / 10000 metrics.
echo [demo] databases: perf_vars_1000, perf_vars_3000, perf_vars_6000, perf_vars_10000
goto finish

:usage
echo Start rtdb-server with the shared demo configuration, or run the demo client
echo in performance mode against an already running server.
echo.
echo Usage:
echo   bin\start-demo-server.bat                        Start the server in this window
echo   bin\start-demo-server.bat bench ^<pts/s^> ^<seconds^> [client options]
echo                                                    Load client only; rtdb-server must
echo                                                    already be running
echo   bin\start-demo-server.bat vars ^<pts/s^> ^<seconds^> [client options]
echo                                                    Variable-count ladder: bench for 1000 /
echo                                                    3000 / 6000 / 10000 metrics, one database
echo                                                    per point (perf_vars_^<count^>)
echo   bin\start-demo-server.bat remote [host[:port] or url] [client options]
echo                                                    Remote smoke test against the published
echo                                                    instance https://smartsite.top:8081:
echo                                                    one simulated batch + verification.
echo                                                    The optional target accepts
echo                                                    "smartsite.top:8081" (https assumed)
echo   bin\start-demo-server.bat help                   Show this help
echo.
echo Examples:
echo   window 1: bin\start-demo-server.bat
echo   window 2: bin\start-demo-server.bat bench 20000 30
echo   window 2: bin\start-demo-server.bat bench 20000 30 --db perf_demo --interval 500
echo   window 2: bin\start-demo-server.bat bench 5000 60 --points-per-tick 5000
echo   window 2: bin\start-demo-server.bat bench 200000 60 --metrics 10000
echo   window 2: bin\start-demo-server.bat vars 50000 60
echo   bin\start-demo-server.bat remote
echo   bin\start-demo-server.bat remote smartsite.top:8081 --duration 60 --interval 1000
echo.
echo Notes:
echo   - bench never starts a server: start it first in another window or as a service.
echo   - bench sends "rate * interval / 1000" points per batch; the interval comes
echo     from packages\demo\conf\client-smart-site.json (default 1000 ms).
echo   - extra options are forwarded to the demo client unchanged: --db, --interval,
echo     --points-per-tick, --total-points, --metrics, --devices, --verify, ...
echo   - "--metrics <n>" scales the simulated variable count: the 44-tag catalog is
echo     replicated with a "#k" metric-name suffix, so the per-batch capacity grows
echo     to "metrics x interval" points (10000 metrics = 44 tags x 228 copies).
echo   - "vars" runs the ladder 1000 / 3000 / 6000 / 10000 metrics and writes each
echo     point into its own database (perf_vars_^<count^>) so the runs stay comparable.
echo   - "duration" is in seconds; use a large value (or Ctrl+C) to run indefinitely.
echo     Ctrl+C stops only the client, the server keeps running.
echo   - "remote" targets the published instance (default https://smartsite.top:8081,
echo     database smart_site_remote) and verifies the batch it wrote; the first
echo     argument may be "host[:port]" (https assumed) or a full http(s):// URL,
echo     and RTDB_REMOTE_URL / RTDB_REMOTE_DB also override.
echo   - "remote" takes the token from RTDB_TOKEN, else bin\rtdb.remote.token, else it
echo     signs in with RTDB_DEMO_USER / RTDB_DEMO_PASSWORD (default admin / ss-rtdb)
echo     and mints a role=write "demo-remote" token, cached in bin\rtdb.remote.token
echo     (a console-login token would be revoked by the next sign-in mid-run).
echo   - the published 8081 listener uses the smartsite.top certificate, so an https
echo     target must use that host name (a bare IP fails certificate validation).
echo   - set RTDB_PORT when the server listens on a port other than 6180.
exit /b 0

:bench_usage
echo [ERROR] bench/vars needs two arguments: ^<pts/s^> ^<seconds^>
call :print_short_usage
exit /b 1

:print_short_usage
echo.
echo Usage:
echo   bin\start-demo-server.bat [help]
echo   bin\start-demo-server.bat bench ^<pts/s^> ^<seconds^> [client options]
echo   bin\start-demo-server.bat vars ^<pts/s^> ^<seconds^> [client options]
echo   bin\start-demo-server.bat remote [host[:port] or url] [client options]
echo.
exit /b 0

:finish
popd
exit /b %CODE%
