@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_version_header.ps1"
if errorlevel 1 exit /b 1

call "%~dp0setup_msvc_env.bat"
if errorlevel 1 exit /b 1

pushd "%~dp0.."

set "OUT_DIR=%~1"
if "%OUT_DIR%"=="" set "OUT_DIR=build\win-sdk-demo"

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

cl /nologo /c /EHsc /std:c++17 ^
  /DRS_SDK_STATIC ^
  sdk\src\rocksolid_crypto_win.cpp ^
  /I sdk\include ^
  /Fo"%OUT_DIR%\rocksolid_crypto_win.obj"
if errorlevel 1 goto :fail

cl /nologo /c /EHsc /std:c++17 ^
  /DRS_SDK_STATIC ^
  sdk\src\rocksolid_transport_win.cpp ^
  /I sdk\include ^
  /Fo"%OUT_DIR%\rocksolid_transport_win.obj"
if errorlevel 1 goto :fail

cl /nologo /c /EHsc /std:c++17 ^
  /DRS_SDK_STATIC ^
  sdk\examples\windows_client_demo.cpp ^
  /I sdk\include ^
  /Fo"%OUT_DIR%\windows_client_demo.obj"
if errorlevel 1 goto :fail

link /nologo ^
  /OUT:"%OUT_DIR%\windows_client_demo.exe" ^
  /PDB:"%OUT_DIR%\windows_client_demo.pdb" ^
  "%OUT_DIR%\rocksolid_crypto_win.obj" ^
  "%OUT_DIR%\rocksolid_transport_win.obj" ^
  "%OUT_DIR%\windows_client_demo.obj" ^
  bcrypt.lib winhttp.lib ws2_32.lib crypt32.lib
if errorlevel 1 goto :fail

echo Built %OUT_DIR%\windows_client_demo.exe
popd
exit /b 0

:fail
popd
exit /b 1
