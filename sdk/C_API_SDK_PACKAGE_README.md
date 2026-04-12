# RockSolid Windows C API Package

这个发布包面向只需要底层 C 接口的软件作者。

## 包内容

- `include/rocksolid_sdk.h`：C API 头文件
- `bin/rocksolid_sdk.dll`：运行时 DLL
- `lib/rocksolid_sdk.lib`：DLL import library
- `examples/c_api_demo.c`：最小 C 接入示例
- `docs/BUILD_WINDOWS.md`：Windows 构建说明

## 接入要点

- 使用 DLL 包时，不要定义 `RS_SDK_STATIC`
- 你的程序运行时需要能找到 `bin/rocksolid_sdk.dll`
- 当前 DLL 暴露的是底层 C API，适合做：
  - 随机数和设备指纹
  - HMAC 请求签名
  - `licenseToken` 载荷解码
  - `licenseToken` 公钥验签

## 最小接入示例

```bat
cl /nologo examples\c_api_demo.c /I include lib\rocksolid_sdk.lib /Fe:c_api_demo.exe
```

生成的 `c_api_demo.exe` 旁边需要放 `bin\rocksolid_sdk.dll`，或者把 DLL 放进系统 `PATH` 能找到的位置。

## 推荐用途

- 给非 C++ 项目或自定义封装层提供稳定的底层二进制接口
- 自己在上层实现 HTTP/TCP 通信、登录和心跳流程
