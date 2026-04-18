import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("sdk cpp package assets include host skeleton plus cmake and VS2022 consumer hooks", () => {
  const template = readText("sdk/examples/windows_host_skeleton_template.cpp");
  const cmakeHostConsumerMain = readText("sdk/examples/cmake_cpp_host_consumer/main.cpp");
  const cmakeHostConsumerCmake = readText("sdk/examples/cmake_cpp_host_consumer/CMakeLists.txt");
  const cmakeHostConsumerEnv = readText("sdk/examples/cmake_cpp_host_consumer/rocksolid_host_config.env.example");
  const vs2022HostConsumerMain = readText("sdk/examples/vs2022_cpp_host_consumer/main.cpp");
  const vs2022HostConsumerProject = readText("sdk/examples/vs2022_cpp_host_consumer/RockSolidSDKCppHostConsumer.vcxproj");
  const vs2022HostConsumerFilters = readText("sdk/examples/vs2022_cpp_host_consumer/RockSolidSDKCppHostConsumer.vcxproj.filters");
  const vs2022HostConsumerProps = readText("sdk/examples/vs2022_cpp_host_consumer/RockSolidSDK.props");
  const vs2022HostConsumerLocalProps = readText("sdk/examples/vs2022_cpp_host_consumer/RockSolidSDK.local.props");
  const vs2022HostConsumerSolution = readText("sdk/examples/vs2022_cpp_host_consumer/RockSolidSDKCppHostConsumer.sln");
  const vs2022HostConsumerEnv = readText("sdk/examples/vs2022_cpp_host_consumer/rocksolid_host_config.env.example");
  const dedupEnvRunner = readText("sdk/run_with_dedup_env.mjs");
  const packageScript = readText("sdk/package_release.bat");
  const verifyScript = readText("sdk/verify_release_package.bat");
  const packageReadme = readText("sdk/CPP_SDK_PACKAGE_README.md");
  const guide = readText("sdk/WINDOWS_SDK_GUIDE.md");
  const buildGuide = readText("sdk/BUILD_WINDOWS.md");

  assert.match(template, /FeatureGate/);
  assert.match(template, /startup_bootstrap_http/);
  assert.match(template, /validate_license_token_with_bootstrap/);
  assert.match(template, /heartbeat_http_parsed/);

  assert.match(cmakeHostConsumerMain, /rocksolid_host_config\.env/);
  assert.match(cmakeHostConsumerMain, /RS_REQUIRE_LOCAL_TOKEN_VALIDATION/);
  assert.match(cmakeHostConsumerMain, /RS_REQUIRE_HEARTBEAT_GATE/);
  assert.match(cmakeHostConsumerMain, /RS_RUN_NETWORK_DEMO/);
  assert.match(cmakeHostConsumerMain, /startup_bootstrap_http/);
  assert.match(cmakeHostConsumerMain, /validate_license_token_with_bootstrap/);
  assert.match(cmakeHostConsumerCmake, /find_package\(RockSolidSDK CONFIG REQUIRED/);
  assert.match(cmakeHostConsumerCmake, /RockSolidSDK::cpp_static/);
  assert.match(cmakeHostConsumerEnv, /RS_PROJECT_CODE=MY_SOFTWARE/);
  assert.match(cmakeHostConsumerEnv, /RS_INCLUDE_TOKEN_KEYS=true/);
  assert.match(cmakeHostConsumerEnv, /RS_RUN_NETWORK_DEMO=false/);
  assert.match(vs2022HostConsumerMain, /\.\.\\\\cmake_cpp_host_consumer\\\\main\.cpp/);
  assert.match(vs2022HostConsumerProject, /PlatformToolset>v143</);
  assert.match(vs2022HostConsumerProject, /Import Project="RockSolidSDK\.props"/);
  assert.match(vs2022HostConsumerProject, /Import Project="RockSolidSDK\.local\.props"/);
  assert.doesNotMatch(vs2022HostConsumerProject, /rocksolid_sdk_static\.lib/);
  assert.match(vs2022HostConsumerProject, /rocksolid_host_config\.env\.example/);
  assert.match(vs2022HostConsumerFilters, /Source Files/);
  assert.match(vs2022HostConsumerFilters, /Config/);
  assert.match(vs2022HostConsumerFilters, /RockSolidSDK\.props/);
  assert.match(vs2022HostConsumerFilters, /RockSolidSDK\.local\.props/);
  assert.match(vs2022HostConsumerProps, /ROCKSOLID_SDK_ROOT/);
  assert.match(vs2022HostConsumerProps, /AdditionalLibraryDirectories>/);
  assert.match(vs2022HostConsumerProps, /rocksolid_sdk_static\.lib/);
  assert.match(vs2022HostConsumerLocalProps, /ROCKSOLID_SDK_ROOT_OVERRIDE/);
  assert.match(vs2022HostConsumerLocalProps, /LocalDebuggerWorkingDirectory/);
  assert.match(vs2022HostConsumerSolution, /RockSolidSDKCppHostConsumer\.vcxproj/);
  assert.match(vs2022HostConsumerEnv, /RS_PROJECT_CODE=MY_SOFTWARE/);
  assert.match(vs2022HostConsumerEnv, /RS_RUN_NETWORK_DEMO=false/);
  assert.match(dedupEnvRunner, /process\.env/);
  assert.match(dedupEnvRunner, /name\.toLowerCase\(\)/);
  assert.match(dedupEnvRunner, /spawnSync/);

  assert.match(packageScript, /windows_host_skeleton_template\.cpp/);
  assert.match(packageScript, /cmake_cpp_host_consumer/);
  assert.match(packageScript, /vs2022_cpp_host_consumer/);
  assert.match(verifyScript, /windows_host_skeleton_template\.cpp/);
  assert.match(verifyScript, /windows_host_skeleton_template\.exe/);
  assert.match(verifyScript, /cmake_cpp_host_consumer/);
  assert.match(verifyScript, /cmake-cpp-validate-build/);
  assert.match(verifyScript, /RockSolidSDKCppHostConsumer\.vcxproj/);
  assert.match(verifyScript, /Configuration=Release/);
  assert.match(verifyScript, /RockSolidSDKCppHostConsumer\.exe/);
  assert.match(verifyScript, /where msbuild/);
  assert.match(verifyScript, /run_with_dedup_env\.mjs/);

  assert.match(packageReadme, /windows_host_skeleton_template\.cpp/);
  assert.match(packageReadme, /cmake_cpp_host_consumer/);
  assert.match(packageReadme, /vs2022_cpp_host_consumer/);
  assert.match(packageReadme, /RockSolidSDK\.local\.props/);
  assert.match(packageReadme, /rocksolid_host_config\.env/);
  assert.match(packageReadme, /host-app startup\/login\/heartbeat skeleton/);

  assert.match(guide, /windows_host_skeleton_template\.cpp/);
  assert.match(guide, /cmake_cpp_host_consumer/);
  assert.match(guide, /vs2022_cpp_host_consumer/);
  assert.match(guide, /RockSolidSDK\.local\.props/);
  assert.match(guide, /rocksolid_host_config\.env/);
  assert.match(buildGuide, /host-app-oriented C\+\+ skeleton template/);
  assert.match(buildGuide, /CMake consumer skeleton/);
  assert.match(buildGuide, /native VS2022 consumer example/);
  assert.match(buildGuide, /RockSolidSDK\.local\.props/);
});
