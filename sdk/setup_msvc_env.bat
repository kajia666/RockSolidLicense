@echo off

where cl >nul 2>nul
if not errorlevel 1 goto :eof

set "RS_VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%RS_VSWHERE%" set "RS_VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"

if exist "%RS_VSWHERE%" (
  for /f "usebackq delims=" %%I in (`"%RS_VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "RS_VS_INSTALL=%%I"
)

if not defined RS_VS_INSTALL (
  echo Could not locate Visual Studio with C++ tools.
  echo Install Visual Studio 2022 and the "Desktop development with C++" workload.
  exit /b 1
)

set "RS_VSDEVCMD=%RS_VS_INSTALL%\Common7\Tools\VsDevCmd.bat"
if not exist "%RS_VSDEVCMD%" (
  echo Could not find VsDevCmd.bat at "%RS_VSDEVCMD%".
  exit /b 1
)

call "%RS_VSDEVCMD%" -host_arch=x64 -arch=x64 >nul
if errorlevel 1 (
  echo Failed to initialize the Visual Studio build environment.
  exit /b 1
)

where cl >nul 2>nul
if errorlevel 1 (
  echo cl.exe is unavailable after initializing Visual Studio tools.
  exit /b 1
)
