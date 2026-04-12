@echo off
setlocal

call "%~dp0setup_msvc_env.bat"
if errorlevel 1 exit /b 1

pushd "%~dp0.."

set "OUT_DIR=%~1"
if "%OUT_DIR%"=="" set "OUT_DIR=build\win-sdk-release"

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

cl /nologo /c /EHsc /std:c++17 /DRS_SDK_BUILD_DLL ^
  sdk\src\rocksolid_crypto_win.cpp ^
  /I sdk\include ^
  /Fo"%OUT_DIR%\rocksolid_crypto_win.obj"
if errorlevel 1 goto :fail

link /nologo /DLL ^
  /OUT:"%OUT_DIR%\rocksolid_sdk.dll" ^
  /IMPLIB:"%OUT_DIR%\rocksolid_sdk.lib" ^
  "%OUT_DIR%\rocksolid_crypto_win.obj" ^
  bcrypt.lib crypt32.lib
if errorlevel 1 goto :fail

echo Built %OUT_DIR%\rocksolid_sdk.dll
echo Built %OUT_DIR%\rocksolid_sdk.lib
popd
exit /b 0

:fail
popd
exit /b 1
