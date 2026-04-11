# VS2022 Checklist

The current Windows SDK demo was successfully compiled on this machine with Visual Studio 2022.

That means your environment already has the required components:

- Visual Studio 2022
- Desktop development with C++
- MSVC v143 C++ x64/x86 build tools
- Windows 10 or 11 SDK

## Optional components

You do not need these for the current SDK source to compile, but they can still be useful:

- C++ CMake tools for Windows
  Useful if you want to switch the SDK demo to CMake later.
- ATL/MFC
  Not required for this project.
- Spectre-mitigated libraries
  Optional if your release process requires them.

## Local verification result

I successfully invoked:

- `cl`
- `link`
- the SDK demo compile command from `sdk/BUILD_WINDOWS.md`

So right now you do not need to install anything else just to build the current Windows SDK demo.
