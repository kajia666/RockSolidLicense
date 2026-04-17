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

test("sdk cpp package assets include the host skeleton template and packaging hooks", () => {
  const template = readText("sdk/examples/windows_host_skeleton_template.cpp");
  const cmakeHostConsumerMain = readText("sdk/examples/cmake_cpp_host_consumer/main.cpp");
  const cmakeHostConsumerCmake = readText("sdk/examples/cmake_cpp_host_consumer/CMakeLists.txt");
  const packageScript = readText("sdk/package_release.bat");
  const verifyScript = readText("sdk/verify_release_package.bat");
  const packageReadme = readText("sdk/CPP_SDK_PACKAGE_README.md");
  const guide = readText("sdk/WINDOWS_SDK_GUIDE.md");
  const buildGuide = readText("sdk/BUILD_WINDOWS.md");

  assert.match(template, /FeatureGate/);
  assert.match(template, /startup_bootstrap_http/);
  assert.match(template, /validate_license_token_with_bootstrap/);
  assert.match(template, /heartbeat_http_parsed/);

  assert.match(cmakeHostConsumerMain, /run_network_demo = false/);
  assert.match(cmakeHostConsumerMain, /startup_bootstrap_http/);
  assert.match(cmakeHostConsumerMain, /validate_license_token_with_bootstrap/);
  assert.match(cmakeHostConsumerCmake, /find_package\(RockSolidSDK CONFIG REQUIRED/);
  assert.match(cmakeHostConsumerCmake, /RockSolidSDK::cpp_static/);

  assert.match(packageScript, /windows_host_skeleton_template\.cpp/);
  assert.match(packageScript, /cmake_cpp_host_consumer/);
  assert.match(verifyScript, /windows_host_skeleton_template\.cpp/);
  assert.match(verifyScript, /windows_host_skeleton_template\.exe/);
  assert.match(verifyScript, /cmake_cpp_host_consumer/);
  assert.match(verifyScript, /cmake-cpp-host-consumer-build/);

  assert.match(packageReadme, /windows_host_skeleton_template\.cpp/);
  assert.match(packageReadme, /cmake_cpp_host_consumer/);
  assert.match(packageReadme, /host-app startup\/login\/heartbeat skeleton/);

  assert.match(guide, /windows_host_skeleton_template\.cpp/);
  assert.match(guide, /cmake_cpp_host_consumer/);
  assert.match(buildGuide, /host-app-oriented C\+\+ skeleton template/);
  assert.match(buildGuide, /CMake consumer skeleton/);
});
