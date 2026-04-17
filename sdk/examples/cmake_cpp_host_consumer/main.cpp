#include "rocksolid_transport_win.hpp"

#include <iostream>
#include <string>

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

struct HostConfig {
  std::string sdk_app_id = "app_replace_me";
  std::string sdk_app_secret = "secret_replace_me";
  std::string app_salt = "my-product-salt";
  std::string product_code = "MY_SOFTWARE";
  std::string client_version = "1.0.0";
  std::string channel = "stable";
};

void set_feature_gate(FeatureGate& gate, bool enabled, const std::string& reason) {
  gate.protected_features_enabled = enabled;
  gate.reason = reason;
  std::cout << "[gate] protected="
            << (enabled ? "true" : "false")
            << " reason=" << reason << std::endl;
}

rocksolid::LicenseClientWin build_client(const HostConfig& config) {
  rocksolid::ClientIdentity identity{
    config.sdk_app_id,
    config.sdk_app_secret,
    config.app_salt
  };

  rocksolid::HttpEndpoint http_endpoint;
  http_endpoint.host = L"127.0.0.1";
  http_endpoint.port = 3000;
  http_endpoint.secure = false;

  rocksolid::TcpEndpoint tcp_endpoint;
  tcp_endpoint.host = "127.0.0.1";
  tcp_endpoint.port = 4000;

  return rocksolid::LicenseClientWin(identity, http_endpoint, tcp_endpoint);
}

}  // namespace host_app

int main() {
  try {
    const host_app::HostConfig config{};
    rocksolid::LicenseClientWin client = host_app::build_client(config);
    host_app::FeatureGate gate;
    host_app::RuntimeSession runtime;

    std::cout << "sdk_version=" << rocksolid::sdk_version_string() << std::endl;
    host_app::set_feature_gate(gate, false, "startup_bootstrap_pending");

    const bool run_network_demo = false;
    if (!run_network_demo) {
      std::cout << "Host consumer skeleton is ready." << std::endl;
      std::cout << "Replace sdk_app_id, sdk_app_secret, product_code, and transport endpoints," << std::endl;
      std::cout << "then flip run_network_demo=true to exercise startup/login/heartbeat." << std::endl;
      return 0;
    }

    const std::string device_fingerprint = client.generate_device_fingerprint();
    const rocksolid::ClientStartupBootstrapResponse startup =
      client.startup_bootstrap_http({
        config.product_code,
        config.client_version,
        config.channel,
        true
      });
    const rocksolid::ClientStartupDecision startup_decision =
      rocksolid::LicenseClientWin::evaluate_startup_decision(startup);

    if (!startup_decision.allow_login) {
      host_app::set_feature_gate(gate, false, startup_decision.primary_code);
      std::cout << startup_decision.primary_message << std::endl;
      return 0;
    }

    runtime.startup_cache = {
      1,
      rocksolid::iso8601_now_utc(),
      startup
    };

    runtime.login = client.login_http_parsed({
      config.product_code,
      "demo_user",
      "demo_password",
      device_fingerprint,
      "Demo Workstation",
      config.client_version,
      config.channel
    });
    runtime.logged_in = true;

    const rocksolid::TokenValidationResult validation =
      rocksolid::LicenseClientWin::validate_license_token_with_bootstrap(
        runtime.login.license_token,
        runtime.startup_cache.bootstrap
      );
    if (!validation.valid) {
      host_app::set_feature_gate(gate, false, "local_token_validation_failed");
      std::cerr << "licenseToken validation failed." << std::endl;
      return 1;
    }

    host_app::set_feature_gate(gate, true, "session_active");

    const rocksolid::HeartbeatResponse heartbeat =
      client.heartbeat_http_parsed({
        config.product_code,
        runtime.login.session_token,
        device_fingerprint,
        config.client_version,
        config.channel
      });

    std::cout << "[heartbeat] status=" << heartbeat.status
              << " next=" << heartbeat.next_heartbeat_in_seconds << "s" << std::endl;
    if (heartbeat.status != "active") {
      host_app::set_feature_gate(gate, false, "heartbeat_not_active");
    }

    return 0;
  } catch (const rocksolid::ApiException& error) {
    std::cerr << "RockSolid API failed: code=" << error.code()
              << " status=" << error.status()
              << " transportStatus=" << error.transport_status()
              << " message=" << error.what() << std::endl;
    return 1;
  } catch (const std::exception& error) {
    std::cerr << "Host consumer skeleton failed: " << error.what() << std::endl;
    return 1;
  }
}
