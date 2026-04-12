@echo off
setlocal

if not exist build\win-sdk-release mkdir build\win-sdk-release

cl /nologo /c /EHsc /std:c++17 /DRS_SDK_STATIC ^
  sdk\src\rocksolid_crypto_win.cpp ^
  sdk\src\rocksolid_transport_win.cpp ^
  /I sdk\include ^
  /Fobuild\win-sdk-release\\
if errorlevel 1 exit /b 1

lib /nologo ^
  /OUT:build\win-sdk-release\rocksolid_sdk_static.lib ^
  build\win-sdk-release\rocksolid_crypto_win.obj ^
  build\win-sdk-release\rocksolid_transport_win.obj
if errorlevel 1 exit /b 1

echo Built build\win-sdk-release\rocksolid_sdk_static.lib
