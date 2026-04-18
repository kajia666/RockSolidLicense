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
set "VERIFY_ROOT=%RELEASE_ROOT%\validation-%RS_SDK_VERSION%-%RANDOM%%RANDOM%"
set "CMAKE_EXE="
set "MSBUILD_EXE="

for %%I in ("%CPP_ROOT%") do set "CPP_ROOT_FULL=%%~fI"
for %%I in ("%CAPI_ROOT%") do set "CAPI_ROOT_FULL=%%~fI"

if not exist "%CPP_ROOT%\examples\windows_client_demo.cpp" (
  echo Missing C++ package at %CPP_ROOT%
  goto :fail
)

if not exist "%CPP_ROOT%\examples\windows_host_skeleton_template.cpp" (
  echo Missing C++ host skeleton template at %CPP_ROOT%\examples\windows_host_skeleton_template.cpp
  goto :fail
)

if not exist "%CAPI_ROOT%\examples\c_api_demo.c" (
  echo Missing C API package at %CAPI_ROOT%
  goto :fail
)

if not exist "%CPP_ROOT%\examples\cmake_cpp_consumer\CMakeLists.txt" (
  echo Missing packaged CMake C++ consumer example at %CPP_ROOT%\examples\cmake_cpp_consumer
  goto :fail
)

if not exist "%CPP_ROOT%\examples\cmake_cpp_host_consumer\CMakeLists.txt" (
  echo Missing packaged CMake C++ host consumer example at %CPP_ROOT%\examples\cmake_cpp_host_consumer
  goto :fail
)

if not exist "%CPP_ROOT%\examples\cmake_cpp_host_consumer\rocksolid_host_config.env.example" (
  echo Missing packaged host consumer env template at %CPP_ROOT%\examples\cmake_cpp_host_consumer\rocksolid_host_config.env.example
  goto :fail
)

if not exist "%CPP_ROOT%\examples\vs2022_cpp_host_consumer\RockSolidSDKCppHostConsumer.sln" (
  echo Missing packaged VS2022 host consumer solution at %CPP_ROOT%\examples\vs2022_cpp_host_consumer\RockSolidSDKCppHostConsumer.sln
  goto :fail
)

if not exist "%CPP_ROOT%\examples\vs2022_cpp_host_consumer\RockSolidSDKCppHostConsumer.vcxproj" (
  echo Missing packaged VS2022 host consumer project at %CPP_ROOT%\examples\vs2022_cpp_host_consumer\RockSolidSDKCppHostConsumer.vcxproj
  goto :fail
)

if not exist "%CPP_ROOT%\examples\vs2022_cpp_host_consumer\rocksolid_host_config.env.example" (
  echo Missing packaged VS2022 host consumer env template at %CPP_ROOT%\examples\vs2022_cpp_host_consumer\rocksolid_host_config.env.example
  goto :fail
)

if not exist "%CAPI_ROOT%\examples\cmake_capi_consumer\CMakeLists.txt" (
  echo Missing packaged CMake C API consumer example at %CAPI_ROOT%\examples\cmake_capi_consumer
  goto :fail
)

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

cl /nologo /EHsc /std:c++17 /DRS_SDK_STATIC ^
  "%CPP_ROOT%\examples\windows_host_skeleton_template.cpp" ^
  /I "%CPP_ROOT%\include" ^
  "%CPP_ROOT%\lib\rocksolid_sdk_static.lib" ^
  bcrypt.lib winhttp.lib ws2_32.lib crypt32.lib ^
  /Fe"%VERIFY_ROOT%\cpp\windows_host_skeleton_template.exe" ^
  /Fo"%VERIFY_ROOT%\cpp\\" ^
  /Fd"%VERIFY_ROOT%\cpp\\windows_host_skeleton_template.pdb"
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

where msbuild >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%I in ('where msbuild') do (
    set "MSBUILD_EXE=%%I"
    goto :msbuild_found
  )
)

for %%I in (
  "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe"
  "C:\Program Files\Microsoft Visual Studio\2022\Professional\MSBuild\Current\Bin\MSBuild.exe"
  "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\MSBuild\Current\Bin\MSBuild.exe"
  "C:\Program Files (x86)\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe"
  "C:\Program Files (x86)\Microsoft Visual Studio\2022\Professional\MSBuild\Current\Bin\MSBuild.exe"
  "C:\Program Files (x86)\Microsoft Visual Studio\2022\Enterprise\MSBuild\Current\Bin\MSBuild.exe"
) do (
  if exist %%~I (
    set "MSBUILD_EXE=%%~I"
    goto :msbuild_found
  )
)

goto :msbuild_done

:msbuild_found
node sdk\run_with_dedup_env.mjs --cwd "%CPP_ROOT%\examples\vs2022_cpp_host_consumer" ^
  "%MSBUILD_EXE%" RockSolidSDKCppHostConsumer.vcxproj /m /p:Configuration=Release /p:Platform=x64
if errorlevel 1 (
  if not exist "%CPP_ROOT%\examples\vs2022_cpp_host_consumer\build\Release\RockSolidSDKCppHostConsumer.exe" goto :fail
)

:msbuild_done

where cmake >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%I in ('where cmake') do (
    set "CMAKE_EXE=%%I"
    goto :cmake_found
  )
)

for %%I in (
  "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
  "C:\Program Files\Microsoft Visual Studio\2022\Professional\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
  "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
  "C:\Program Files (x86)\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
  "C:\Program Files (x86)\Microsoft Visual Studio\2022\Professional\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
  "C:\Program Files (x86)\Microsoft Visual Studio\2022\Enterprise\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
) do (
  if exist %%~I (
    set "CMAKE_EXE=%%~I"
    goto :cmake_found
  )
)

goto :cmake_done

:cmake_found
set "CPP_ROOT_CMAKE=%CPP_ROOT_FULL:\=/%"
set "CAPI_ROOT_CMAKE=%CAPI_ROOT_FULL:\=/%"

mkdir "%VERIFY_ROOT%\cmake-cpp-validate" 2>nul
mkdir "%VERIFY_ROOT%\cmake-capi-validate" 2>nul

> "%VERIFY_ROOT%\cmake-cpp-validate\CMakeLists.txt" echo cmake_minimum_required(VERSION 3.20)
>>"%VERIFY_ROOT%\cmake-cpp-validate\CMakeLists.txt" echo project(RockSolidSDKCppConfigValidation LANGUAGES NONE)
>>"%VERIFY_ROOT%\cmake-cpp-validate\CMakeLists.txt" echo find_package(RockSolidSDK CONFIG REQUIRED PATHS "%CPP_ROOT_CMAKE%/cmake" NO_DEFAULT_PATH)
>>"%VERIFY_ROOT%\cmake-cpp-validate\CMakeLists.txt" echo if(NOT TARGET RockSolidSDK::cpp_static)
>>"%VERIFY_ROOT%\cmake-cpp-validate\CMakeLists.txt" echo   message(FATAL_ERROR "Missing target RockSolidSDK::cpp_static")
>>"%VERIFY_ROOT%\cmake-cpp-validate\CMakeLists.txt" echo endif()
>>"%VERIFY_ROOT%\cmake-cpp-validate\CMakeLists.txt" echo get_target_property(_cpp_include RockSolidSDK::cpp_static INTERFACE_INCLUDE_DIRECTORIES)
>>"%VERIFY_ROOT%\cmake-cpp-validate\CMakeLists.txt" echo if(NOT EXISTS "${_cpp_include}/rocksolid_client.hpp")
>>"%VERIFY_ROOT%\cmake-cpp-validate\CMakeLists.txt" echo   message(FATAL_ERROR "Missing rocksolid_client.hpp in imported include directory")
>>"%VERIFY_ROOT%\cmake-cpp-validate\CMakeLists.txt" echo endif()
>>"%VERIFY_ROOT%\cmake-cpp-validate\CMakeLists.txt" echo get_target_property(_cpp_lib RockSolidSDK::cpp_static IMPORTED_LOCATION)
>>"%VERIFY_ROOT%\cmake-cpp-validate\CMakeLists.txt" echo if(NOT EXISTS "${_cpp_lib}")
>>"%VERIFY_ROOT%\cmake-cpp-validate\CMakeLists.txt" echo   message(FATAL_ERROR "Missing static library referenced by RockSolidSDK::cpp_static")
>>"%VERIFY_ROOT%\cmake-cpp-validate\CMakeLists.txt" echo endif()

"%CMAKE_EXE%" -S "%VERIFY_ROOT%\cmake-cpp-validate" -B "%VERIFY_ROOT%\cmake-cpp-validate-build" -G "NMake Makefiles"
if errorlevel 1 goto :fail

> "%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo cmake_minimum_required(VERSION 3.20)
>>"%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo project(RockSolidSDKCapiConfigValidation LANGUAGES NONE)
>>"%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo find_package(RockSolidSDK CONFIG REQUIRED PATHS "%CAPI_ROOT_CMAKE%/cmake" NO_DEFAULT_PATH)
>>"%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo if(NOT TARGET RockSolidSDK::capi)
>>"%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo   message(FATAL_ERROR "Missing target RockSolidSDK::capi")
>>"%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo endif()
>>"%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo get_target_property(_capi_include RockSolidSDK::capi INTERFACE_INCLUDE_DIRECTORIES)
>>"%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo if(NOT EXISTS "${_capi_include}/rocksolid_sdk.h")
>>"%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo   message(FATAL_ERROR "Missing rocksolid_sdk.h in imported include directory")
>>"%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo endif()
>>"%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo get_target_property(_capi_implib RockSolidSDK::capi IMPORTED_IMPLIB)
>>"%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo if(NOT EXISTS "${_capi_implib}")
>>"%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo   message(FATAL_ERROR "Missing import library referenced by RockSolidSDK::capi")
>>"%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo endif()
>>"%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo get_target_property(_capi_dll RockSolidSDK::capi IMPORTED_LOCATION)
>>"%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo if(NOT EXISTS "${_capi_dll}")
>>"%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo   message(FATAL_ERROR "Missing DLL referenced by RockSolidSDK::capi")
>>"%VERIFY_ROOT%\cmake-capi-validate\CMakeLists.txt" echo endif()

"%CMAKE_EXE%" -S "%VERIFY_ROOT%\cmake-capi-validate" -B "%VERIFY_ROOT%\cmake-capi-validate-build" -G "NMake Makefiles"
if errorlevel 1 goto :fail

:cmake_done

echo Verified %CPP_NAME%
echo Verified %CAPI_NAME%
echo Smoke test output: %VERIFY_ROOT%
popd
exit /b 0

:fail
popd
exit /b 1
