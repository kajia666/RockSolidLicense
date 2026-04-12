@echo off
setlocal

pushd "%~dp0.."

set "RELEASE_ROOT=%~1"
if "%RELEASE_ROOT%"=="" set "RELEASE_ROOT=build\win-sdk-package"

call sdk\package_release.bat "%RELEASE_ROOT%"
if errorlevel 1 goto :fail

call sdk\verify_release_package.bat "%RELEASE_ROOT%"
if errorlevel 1 goto :fail

echo Release workflow completed for %RELEASE_ROOT%
popd
exit /b 0

:fail
popd
exit /b 1
