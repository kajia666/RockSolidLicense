@echo off
setlocal

pushd "%~dp0.."

powershell -NoProfile -ExecutionPolicy Bypass -File "sdk\build_version_header.ps1"
if errorlevel 1 goto :fail

set "PKG_ROOT=%~1"
if "%PKG_ROOT%"=="" set "PKG_ROOT=build\win-sdk-package"

set /p RS_SDK_VERSION=<sdk\VERSION
set "RELEASE_DIR=build\win-sdk-release"
set "CPP_NAME=rocksolid-sdk-cpp-%RS_SDK_VERSION%"
set "CAPI_NAME=rocksolid-sdk-capi-%RS_SDK_VERSION%"
set "CPP_ROOT=%PKG_ROOT%\%CPP_NAME%"
set "CAPI_ROOT=%PKG_ROOT%\%CAPI_NAME%"

if not exist "%PKG_ROOT%" mkdir "%PKG_ROOT%"

call sdk\build_static_lib.bat "%RELEASE_DIR%"
if errorlevel 1 goto :fail

call sdk\build_c_api_dll.bat "%RELEASE_DIR%"
if errorlevel 1 goto :fail

if exist "%CPP_ROOT%" rmdir /s /q "%CPP_ROOT%"
if exist "%CAPI_ROOT%" rmdir /s /q "%CAPI_ROOT%"
if exist "%PKG_ROOT%\%CPP_NAME%.zip" del /f /q "%PKG_ROOT%\%CPP_NAME%.zip"
if exist "%PKG_ROOT%\%CAPI_NAME%.zip" del /f /q "%PKG_ROOT%\%CAPI_NAME%.zip"

mkdir "%CPP_ROOT%\include" 2>nul
mkdir "%CPP_ROOT%\lib" 2>nul
mkdir "%CPP_ROOT%\examples" 2>nul
mkdir "%CPP_ROOT%\docs" 2>nul
mkdir "%CPP_ROOT%\cmake" 2>nul

xcopy /Y /I sdk\include\* "%CPP_ROOT%\include\" >nul
copy /Y sdk\CPP_SDK_PACKAGE_README.md "%CPP_ROOT%\README.md" >nul
copy /Y sdk\VERSION "%CPP_ROOT%\VERSION.txt" >nul
copy /Y "%RELEASE_DIR%\rocksolid_sdk_static.lib" "%CPP_ROOT%\lib\" >nul
copy /Y sdk\examples\windows_client_demo.cpp "%CPP_ROOT%\examples\" >nul
copy /Y sdk\examples\windows_host_skeleton_template.cpp "%CPP_ROOT%\examples\" >nul
if exist "%CPP_ROOT%\examples\cmake_cpp_consumer" rmdir /s /q "%CPP_ROOT%\examples\cmake_cpp_consumer"
xcopy /E /I /Y sdk\examples\cmake_cpp_consumer "%CPP_ROOT%\examples\cmake_cpp_consumer\" >nul
if exist "%CPP_ROOT%\examples\cmake_cpp_host_consumer" rmdir /s /q "%CPP_ROOT%\examples\cmake_cpp_host_consumer"
xcopy /E /I /Y sdk\examples\cmake_cpp_host_consumer "%CPP_ROOT%\examples\cmake_cpp_host_consumer\" >nul
if exist "%CPP_ROOT%\examples\vs2022_cpp_host_consumer" rmdir /s /q "%CPP_ROOT%\examples\vs2022_cpp_host_consumer"
xcopy /E /I /Y sdk\examples\vs2022_cpp_host_consumer "%CPP_ROOT%\examples\vs2022_cpp_host_consumer\" >nul
copy /Y sdk\WINDOWS_SDK_GUIDE.md "%CPP_ROOT%\docs\" >nul
copy /Y sdk\BUILD_WINDOWS.md "%CPP_ROOT%\docs\" >nul
copy /Y sdk\CHANGELOG.md "%CPP_ROOT%\docs\" >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "sdk\generate_cmake_package.ps1" -PackageRoot "%CPP_ROOT%" -PackageKind cpp -Version "%RS_SDK_VERSION%"
if errorlevel 1 goto :fail

powershell -NoProfile -ExecutionPolicy Bypass -Command "$manifest = [ordered]@{ packageName = '%CPP_NAME%'; sdkVersion = '%RS_SDK_VERSION%'; packageKind = 'cpp'; libraryFile = 'lib/rocksolid_sdk_static.lib'; versionFile = 'VERSION.txt'; changelogFile = 'docs/CHANGELOG.md'; cmakeConfigDir = 'cmake'; generatedBy = 'sdk/package_release.bat' }; $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath '%CPP_ROOT%\manifest.json' -Encoding ascii"
if errorlevel 1 goto :fail

mkdir "%CAPI_ROOT%\include" 2>nul
mkdir "%CAPI_ROOT%\lib" 2>nul
mkdir "%CAPI_ROOT%\bin" 2>nul
mkdir "%CAPI_ROOT%\examples" 2>nul
mkdir "%CAPI_ROOT%\docs" 2>nul
mkdir "%CAPI_ROOT%\cmake" 2>nul

copy /Y sdk\C_API_SDK_PACKAGE_README.md "%CAPI_ROOT%\README.md" >nul
copy /Y sdk\VERSION "%CAPI_ROOT%\VERSION.txt" >nul
copy /Y sdk\include\rocksolid_sdk.h "%CAPI_ROOT%\include\" >nul
copy /Y sdk\include\rocksolid_sdk_version.h "%CAPI_ROOT%\include\" >nul
copy /Y "%RELEASE_DIR%\rocksolid_sdk.dll" "%CAPI_ROOT%\bin\" >nul
copy /Y "%RELEASE_DIR%\rocksolid_sdk.lib" "%CAPI_ROOT%\lib\" >nul
copy /Y sdk\examples\c_api_demo.c "%CAPI_ROOT%\examples\" >nul
if exist "%CAPI_ROOT%\examples\cmake_capi_consumer" rmdir /s /q "%CAPI_ROOT%\examples\cmake_capi_consumer"
xcopy /E /I /Y sdk\examples\cmake_capi_consumer "%CAPI_ROOT%\examples\cmake_capi_consumer\" >nul
copy /Y sdk\BUILD_WINDOWS.md "%CAPI_ROOT%\docs\" >nul
copy /Y sdk\CHANGELOG.md "%CAPI_ROOT%\docs\" >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "sdk\generate_cmake_package.ps1" -PackageRoot "%CAPI_ROOT%" -PackageKind capi -Version "%RS_SDK_VERSION%"
if errorlevel 1 goto :fail

powershell -NoProfile -ExecutionPolicy Bypass -Command "$manifest = [ordered]@{ packageName = '%CAPI_NAME%'; sdkVersion = '%RS_SDK_VERSION%'; packageKind = 'capi'; libraryFile = 'lib/rocksolid_sdk.lib'; runtimeFile = 'bin/rocksolid_sdk.dll'; versionFile = 'VERSION.txt'; changelogFile = 'docs/CHANGELOG.md'; cmakeConfigDir = 'cmake'; generatedBy = 'sdk/package_release.bat' }; $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath '%CAPI_ROOT%\manifest.json' -Encoding ascii"
if errorlevel 1 goto :fail

powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '%CPP_ROOT%\*' -DestinationPath '%PKG_ROOT%\%CPP_NAME%.zip' -Force"
if errorlevel 1 goto :fail

powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '%CAPI_ROOT%\*' -DestinationPath '%PKG_ROOT%\%CAPI_NAME%.zip' -Force"
if errorlevel 1 goto :fail

powershell -NoProfile -ExecutionPolicy Bypass -File "sdk\generate_release_checksums.ps1" -ReleaseRoot "%PKG_ROOT%" -Version "%RS_SDK_VERSION%"
if errorlevel 1 goto :fail

powershell -NoProfile -ExecutionPolicy Bypass -Command "$manifest = [ordered]@{ sdkVersion = '%RS_SDK_VERSION%'; cppPackageName = '%CPP_NAME%'; capiPackageName = '%CAPI_NAME%'; cppPackageDir = '%CPP_NAME%'; capiPackageDir = '%CAPI_NAME%'; cppZip = '%CPP_NAME%.zip'; capiZip = '%CAPI_NAME%.zip'; checksumFile = 'SHA256SUMS.txt'; checksumJson = 'checksums.json'; generatedBy = 'sdk/package_release.bat' }; $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath '%PKG_ROOT%\release-manifest.json' -Encoding ascii"
if errorlevel 1 goto :fail

echo Packaged %CPP_ROOT%
echo Packaged %CAPI_ROOT%
echo Packaged %PKG_ROOT%\%CPP_NAME%.zip
echo Packaged %PKG_ROOT%\%CAPI_NAME%.zip
echo Packaged %PKG_ROOT%\SHA256SUMS.txt
echo Packaged %PKG_ROOT%\checksums.json
echo Packaged %PKG_ROOT%\release-manifest.json
popd
exit /b 0

:fail
popd
exit /b 1
