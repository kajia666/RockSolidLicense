#ifdef _WIN32

#include "../include/rocksolid_transport_win.hpp"

#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

namespace host_app {

struct FeatureGate {
  bool protected_features_enabled = false;
  std::string reason = "startup_pending";
};

struct RuntimeSession {
  rocksolid::ClientStartupBootstrapCache startup_cache;
  rocksolid::LoginResponse login;
  bool logged_in = false;
};

void set_feature_gate(FeatureGate& gate, bool enabled, const std::string& reason) {
  gate.protected_features_enabled = enabled;
  gate.reason = reason;
  std::cout << "[gate] protected="
            << (enabled ? "true" : "false")
            << " reason=" << reason << std::endl;
}

}  // namespace host_app

int main() {
  try {
    rocksolid::ClientIdentity identity{
      "app_replace_me",
      "secret_replace_me",
      "my-product-salt"
    };

    rocksolid::HttpEndpoint http_endpoint;
    http_endpoint.host = L"127.0.0.1";
    http_endpoint.port = 3000;
    http_endpoint.secure = false;

    rocksolid::TcpEndpoint tcp_endpoint;
    tcp_endpoint.host = "127.0.0.1";
    tcp_endpoint.port = 4000;

    rocksolid::LicenseClientWin client(identity, http_endpoint, tcp_endpoint);

    const std::string product_code = "MY_SOFTWARE";
    const std::string client_version = "1.0.0";
    const std::string channel_name = "stable";
    const bool include_token_keys = true;
    const std::string device_fingerprint = client.generate_device_fingerprint();

    host_app::FeatureGate gate;
    host_app::RuntimeSession runtime;
    host_app::set_feature_gate(gate, false, "startup_bootstrap_pending");

    // Call startup_bootstrap_http(...) before showing login or recharge UI.
    const rocksolid::ClientStartupBootstrapResponse startup =
      client.startup_bootstrap_http({
        product_code,
        client_version,
        channel_name,
        include_token_keys
      });
    const rocksolid::ClientStartupDecision startup_decision =
      rocksolid::LicenseClientWin::evaluate_startup_decision(startup);

    if (!startup_decision.allow_login) {
      std::cout << "[startup] blocked code=" << startup_decision.primary_code
                << " message=" << startup_decision.primary_message << std::endl;
      return 0;
    }

    runtime.startup_cache = {
      1,
      rocksolid::iso8601_now_utc(),
      startup
    };
    rocksolid::LicenseClientWin::write_startup_bootstrap_cache_file(
      "build/win-sdk-demo/startup_cache.json",
      runtime.startup_cache
    );

    rocksolid::LoginRequest login_request{
      product_code,
      "demo_user",
      "demo_password",
      device_fingerprint,
      "Demo Workstation",
      client_version,
      channel_name
    };

    runtime.login = client.login_http_parsed(login_request);
    runtime.logged_in = true;

    // Keep local token validation enabled when the project profile requires it.
    const rocksolid::TokenValidationResult validation =
      rocksolid::LicenseClientWin::validate_license_token_with_bootstrap(
        runtime.login.license_token,
        runtime.startup_cache.bootstrap
      );
    if (!validation.valid) {
      host_app::set_feature_gate(gate, false, "local_token_validation_failed");
      throw std::runtime_error("licenseToken failed local signature validation.");
    }

    host_app::set_feature_gate(gate, true, "session_active");

    // In a real host app, move heartbeat into a background worker and react quickly
    // when the server revokes, expires, or stops renewing the session.
    const rocksolid::HeartbeatResponse heartbeat =
      client.heartbeat_http_parsed({
        product_code,
        runtime.login.session_token,
        device_fingerprint,
        client_version,
        channel_name
      });

    std::cout << "[heartbeat] status=" << heartbeat.status
              << " next=" << heartbeat.next_heartbeat_in_seconds << "s" << std::endl;

    if (heartbeat.status != "active") {
      host_app::set_feature_gate(gate, false, "heartbeat_not_active");
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    return 0;
  } catch (const rocksolid::ApiException& error) {
    std::cerr << "RockSolid API failed: code=" << error.code()
              << " status=" << error.status()
              << " transportStatus=" << error.transport_status()
              << " message=" << error.what() << std::endl;
    return 1;
  } catch (const std::exception& error) {
    std::cerr << "Host skeleton template failed: " << error.what() << std::endl;
    return 1;
  }
}

#endif
