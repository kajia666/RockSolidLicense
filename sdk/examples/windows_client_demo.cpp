#ifdef _WIN32

#include "../include/rocksolid_transport_win.hpp"

#include <iostream>

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

    const std::string fingerprint = client.generate_device_fingerprint();
    std::cout << "Device fingerprint: " << fingerprint << std::endl;
    const std::string client_version = "1.0.0";
    const std::string channel = "stable";

    const rocksolid::ClientStartupBootstrapResponse startup = client.startup_bootstrap_http({
      "MY_SOFTWARE",
      client_version,
      channel,
      true
    });
    const rocksolid::ClientStartupDecision startup_decision =
      rocksolid::LicenseClientWin::evaluate_startup_decision(startup);
    std::cout << "[HTTP startup] versionStatus=" << startup.version_manifest.status
              << " allowed=" << (startup.version_manifest.allowed ? "true" : "false")
              << " latestVersion=" << startup.version_manifest.latest_version
              << " notices=" << startup.notices.notices.size()
              << " activeKid=" << startup.active_token_key.key_id
              << std::endl;
    std::cout << "[Startup decision] allowLogin="
              << (startup_decision.allow_login ? "true" : "false")
              << " code=" << startup_decision.primary_code
              << " message=" << startup_decision.primary_message
              << std::endl;

    rocksolid::RegisterRequest register_request{
      "MY_SOFTWARE",
      "alice",
      "StrongPass123"
    };

    rocksolid::RechargeRequest recharge_request{
      "MY_SOFTWARE",
      "alice",
      "StrongPass123",
      "MYSOFT-AAAAAA-BBBBBB-CCCCCC-DDDDDD"
    };

    rocksolid::LoginRequest login_request{
      "MY_SOFTWARE",
      "alice",
      "StrongPass123",
      fingerprint,
      "Alice Workstation",
      client_version,
      channel
    };

    const rocksolid::RegisterResponse register_result = client.register_http_parsed(register_request);
    std::cout << "[HTTP register] account=" << register_result.account_id << std::endl;

    const rocksolid::RechargeResponse recharge_result = client.recharge_http_parsed(recharge_request);
    std::cout << "[HTTP recharge] entitlement=" << recharge_result.entitlement_id
              << " grant=" << recharge_result.grant_type;
    if (recharge_result.has_points) {
      std::cout << " remainingPoints=" << recharge_result.remaining_points;
    }
    std::cout << std::endl;

    const rocksolid::LoginResponse login_result = client.login_tcp_parsed(login_request);
    std::cout << "[TCP login] session=" << login_result.session_token
              << " binding=" << login_result.binding.id
              << " quota=" << login_result.quota.grant_type;
    if (login_result.quota.metered) {
      std::cout << " remainingPoints=" << login_result.quota.remaining_points;
    }
    std::cout << std::endl;

    rocksolid::BindingsRequest bindings_request{
      "MY_SOFTWARE",
      "alice",
      "StrongPass123",
      ""
    };
    const rocksolid::BindingsResponse bindings_result = client.bindings_http_parsed(bindings_request);
    std::cout << "[HTTP bindings] count=" << bindings_result.bindings.size()
              << " allowClientUnbind=" << (bindings_result.unbind_policy.allow_client_unbind ? "true" : "false")
              << std::endl;

    const bool perform_unbind_demo = false;
    if (perform_unbind_demo && !bindings_result.bindings.empty()) {
      rocksolid::UnbindRequest unbind_request{
        "MY_SOFTWARE",
        "alice",
        "StrongPass123",
        "",
        bindings_result.bindings.front().id,
        "",
        "demo_unbind"
      };
      const rocksolid::UnbindResponse unbind_result = client.unbind_tcp_parsed(unbind_request);
      std::cout << "[TCP unbind] changed=" << (unbind_result.changed ? "true" : "false")
                << " releasedSessions=" << unbind_result.released_sessions
                << std::endl;
    }

    const rocksolid::TokenValidationResult validation =
      rocksolid::LicenseClientWin::validate_license_token_with_key_set(
        login_result.license_token,
        startup.token_keys
      );
    std::cout << "[Token validation local] kid=" << validation.key_id
              << " valid=" << (validation.valid ? "true" : "false") << std::endl;
    std::cout << validation.payload_json << std::endl;
  } catch (const rocksolid::ApiException& error) {
    std::cerr << "RockSolid API failed: code=" << error.code()
              << " status=" << error.status()
              << " transportStatus=" << error.transport_status()
              << " message=" << error.what() << std::endl;
    return 1;
  } catch (const std::exception& error) {
    std::cerr << "RockSolid demo failed: " << error.what() << std::endl;
    return 1;
  }

  return 0;
}

#endif
