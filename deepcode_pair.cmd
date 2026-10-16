@echo off
setlocal
call "%~dp0packages\cli\bin\deepcode_pair.cmd" %*
exit /b %ERRORLEVEL%
