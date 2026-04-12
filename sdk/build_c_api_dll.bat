@echo off
setlocal

if not exist build\win-sdk-release mkdir build\win-sdk-release

cl /nologo /c /EHsc /std:c++17 /DRS_SDK_BUILD_DLL ^
  sdk\src\rocksolid_crypto_win.cpp ^
  /I sdk\include ^
  /Fobuild\win-sdk-release\\
if errorlevel 1 exit /b 1

link /nologo /DLL ^
  /OUT:build\win-sdk-release\rocksolid_sdk.dll ^
  /IMPLIB:build\win-sdk-release\rocksolid_sdk.lib ^
  build\win-sdk-release\rocksolid_crypto_win.obj ^
  bcrypt.lib crypt32.lib
if errorlevel 1 exit /b 1

echo Built build\win-sdk-release\rocksolid_sdk.dll
echo Built build\win-sdk-release\rocksolid_sdk.lib
