@echo off
setlocal

pushd "%~dp0.."

set "PKG_ROOT=%~1"
if "%PKG_ROOT%"=="" set "PKG_ROOT=build\win-sdk-package"

set "RELEASE_DIR=build\win-sdk-release"
set "CPP_ROOT=%PKG_ROOT%\rocksolid-sdk-cpp"
set "CAPI_ROOT=%PKG_ROOT%\rocksolid-sdk-capi"

call sdk\build_static_lib.bat "%RELEASE_DIR%"
if errorlevel 1 goto :fail

call sdk\build_c_api_dll.bat "%RELEASE_DIR%"
if errorlevel 1 goto :fail

if exist "%CPP_ROOT%" rmdir /s /q "%CPP_ROOT%"
if exist "%CAPI_ROOT%" rmdir /s /q "%CAPI_ROOT%"
if exist "%PKG_ROOT%\rocksolid-sdk-cpp.zip" del /f /q "%PKG_ROOT%\rocksolid-sdk-cpp.zip"
if exist "%PKG_ROOT%\rocksolid-sdk-capi.zip" del /f /q "%PKG_ROOT%\rocksolid-sdk-capi.zip"

mkdir "%CPP_ROOT%\include" 2>nul
mkdir "%CPP_ROOT%\lib" 2>nul
mkdir "%CPP_ROOT%\examples" 2>nul
mkdir "%CPP_ROOT%\docs" 2>nul

xcopy /Y /I sdk\include\* "%CPP_ROOT%\include\" >nul
copy /Y sdk\CPP_SDK_PACKAGE_README.md "%CPP_ROOT%\README.md" >nul
copy /Y "%RELEASE_DIR%\rocksolid_sdk_static.lib" "%CPP_ROOT%\lib\" >nul
copy /Y sdk\examples\windows_client_demo.cpp "%CPP_ROOT%\examples\" >nul
copy /Y sdk\WINDOWS_SDK_GUIDE.md "%CPP_ROOT%\docs\" >nul
copy /Y sdk\BUILD_WINDOWS.md "%CPP_ROOT%\docs\" >nul

mkdir "%CAPI_ROOT%\include" 2>nul
mkdir "%CAPI_ROOT%\lib" 2>nul
mkdir "%CAPI_ROOT%\bin" 2>nul
mkdir "%CAPI_ROOT%\examples" 2>nul
mkdir "%CAPI_ROOT%\docs" 2>nul

copy /Y sdk\C_API_SDK_PACKAGE_README.md "%CAPI_ROOT%\README.md" >nul
copy /Y sdk\include\rocksolid_sdk.h "%CAPI_ROOT%\include\" >nul
copy /Y "%RELEASE_DIR%\rocksolid_sdk.dll" "%CAPI_ROOT%\bin\" >nul
copy /Y "%RELEASE_DIR%\rocksolid_sdk.lib" "%CAPI_ROOT%\lib\" >nul
copy /Y sdk\examples\c_api_demo.c "%CAPI_ROOT%\examples\" >nul
copy /Y sdk\BUILD_WINDOWS.md "%CAPI_ROOT%\docs\" >nul

powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '%CPP_ROOT%\*' -DestinationPath '%PKG_ROOT%\rocksolid-sdk-cpp.zip' -Force"
if errorlevel 1 goto :fail

powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '%CAPI_ROOT%\*' -DestinationPath '%PKG_ROOT%\rocksolid-sdk-capi.zip' -Force"
if errorlevel 1 goto :fail

echo Packaged %CPP_ROOT%
echo Packaged %CAPI_ROOT%
echo Packaged %PKG_ROOT%\rocksolid-sdk-cpp.zip
echo Packaged %PKG_ROOT%\rocksolid-sdk-capi.zip
popd
exit /b 0

:fail
popd
exit /b 1
