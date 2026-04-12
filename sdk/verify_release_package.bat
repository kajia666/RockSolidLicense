@echo off
setlocal

call "%~dp0setup_msvc_env.bat"
if errorlevel 1 exit /b 1

pushd "%~dp0.."

set "RELEASE_ROOT=%~1"
if "%RELEASE_ROOT%"=="" set "RELEASE_ROOT=build\win-sdk-package"

set "RS_SDK_VERSION=%~2"
if "%RS_SDK_VERSION%"=="" set /p RS_SDK_VERSION=<sdk\VERSION

set "CPP_NAME=rocksolid-sdk-cpp-%RS_SDK_VERSION%"
set "CAPI_NAME=rocksolid-sdk-capi-%RS_SDK_VERSION%"
set "CPP_ROOT=%RELEASE_ROOT%\%CPP_NAME%"
set "CAPI_ROOT=%RELEASE_ROOT%\%CAPI_NAME%"
set "VERIFY_ROOT=%RELEASE_ROOT%\validation-%RS_SDK_VERSION%"

if not exist "%CPP_ROOT%\examples\windows_client_demo.cpp" (
  echo Missing C++ package at %CPP_ROOT%
  goto :fail
)

if not exist "%CAPI_ROOT%\examples\c_api_demo.c" (
  echo Missing C API package at %CAPI_ROOT%
  goto :fail
)

if exist "%VERIFY_ROOT%" rmdir /s /q "%VERIFY_ROOT%"
mkdir "%VERIFY_ROOT%\cpp" 2>nul
mkdir "%VERIFY_ROOT%\capi" 2>nul

cl /nologo /EHsc /std:c++17 /DRS_SDK_STATIC ^
  "%CPP_ROOT%\examples\windows_client_demo.cpp" ^
  /I "%CPP_ROOT%\include" ^
  "%CPP_ROOT%\lib\rocksolid_sdk_static.lib" ^
  bcrypt.lib winhttp.lib ws2_32.lib crypt32.lib ^
  /Fe"%VERIFY_ROOT%\cpp\windows_client_demo.exe" ^
  /Fo"%VERIFY_ROOT%\cpp\\" ^
  /Fd"%VERIFY_ROOT%\cpp\\windows_client_demo.pdb"
if errorlevel 1 goto :fail

cl /nologo ^
  "%CAPI_ROOT%\examples\c_api_demo.c" ^
  /I "%CAPI_ROOT%\include" ^
  "%CAPI_ROOT%\lib\rocksolid_sdk.lib" ^
  /Fe"%VERIFY_ROOT%\capi\c_api_demo.exe" ^
  /Fo"%VERIFY_ROOT%\capi\\"
if errorlevel 1 goto :fail

copy /Y "%CAPI_ROOT%\bin\rocksolid_sdk.dll" "%VERIFY_ROOT%\capi\" >nul
if errorlevel 1 goto :fail

"%VERIFY_ROOT%\capi\c_api_demo.exe" > "%VERIFY_ROOT%\capi\c_api_demo.out"
if errorlevel 1 goto :fail

findstr /C:"sdk_version=%RS_SDK_VERSION%" "%VERIFY_ROOT%\capi\c_api_demo.out" >nul
if errorlevel 1 (
  echo Release smoke test failed: c_api_demo output did not report sdk_version=%RS_SDK_VERSION%.
  goto :fail
)

echo Verified %CPP_NAME%
echo Verified %CAPI_NAME%
echo Smoke test output: %VERIFY_ROOT%
popd
exit /b 0

:fail
popd
exit /b 1
