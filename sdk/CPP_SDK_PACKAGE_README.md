# RockSolid Windows C++ SDK Package

这个发布包面向接入完整 Windows C++ 客户端能力的软件作者。

## 包内容

- `include/`：全部公开头文件
- `lib/rocksolid_sdk_static.lib`：完整 C++ SDK 静态库
- `examples/windows_client_demo.cpp`：高层客户端示例
- `docs/WINDOWS_SDK_GUIDE.md`：SDK 功能与接口说明
- `docs/BUILD_WINDOWS.md`：Windows 构建说明

## 接入要点

- 在你的工程里定义 `RS_SDK_STATIC`
- 编译器建议使用 `C++17`
- 额外链接这些系统库：
  - `bcrypt.lib`
  - `winhttp.lib`
  - `ws2_32.lib`
  - `crypt32.lib`

静态库包之所以要求 `RS_SDK_STATIC`，是因为 [rocksolid_sdk.h](/D:/code/OnlineVerification/sdk/include/rocksolid_sdk.h) 会根据这个宏决定是否使用 DLL 导入声明。

## 最小接入示例

```bat
cl /nologo /EHsc /std:c++17 /DRS_SDK_STATIC ^
  examples\windows_client_demo.cpp ^
  /I include ^
  lib\rocksolid_sdk_static.lib ^
  bcrypt.lib winhttp.lib ws2_32.lib crypt32.lib
```

如果你使用 Visual Studio 工程：

- 在“C/C++ -> 预处理器”里加入 `RS_SDK_STATIC`
- 在“C/C++ -> 语言”里启用 `C++17`
- 在“链接器 -> 输入”里加入上面的 `.lib`

## 推荐用途

- 直接接入 `LicenseClientWin`
- 使用 HTTP/TCP 登录、心跳、公告、版本检查、自助解绑等高层能力
- 在客户端本地做 `licenseToken` 验签和启动缓存恢复
