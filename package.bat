@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title MultiTool Office Next 打包
set "NO_PAUSE="
set "PACKAGE_ARGS="
:parse
if "%~1"=="" goto run
if /i "%~1"=="-y" goto no_pause
if /i "%~1"=="--yes" goto no_pause
if /i "%~1"=="/y" goto no_pause
if /i "%~1"=="-NoPause" goto no_pause
set "PACKAGE_ARGS=%PACKAGE_ARGS% %1"
shift
goto parse
:no_pause
set "NO_PAUSE=1"
shift
goto parse
:run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows.ps1" -Action package %PACKAGE_ARGS%
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" echo 打包失败，请检查上方错误信息。
if not defined NO_PAUSE if not defined CI pause
exit /b %EXIT_CODE%
