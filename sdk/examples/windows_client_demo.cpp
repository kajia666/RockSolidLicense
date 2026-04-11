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
      "Alice Workstation"
    };

    const rocksolid::RegisterResponse register_result = client.register_http_parsed(register_request);
    std::cout << "[HTTP register] account=" << register_result.account_id << std::endl;

    const rocksolid::RechargeResponse recharge_result = client.recharge_http_parsed(recharge_request);
    std::cout << "[HTTP recharge] entitlement=" << recharge_result.entitlement_id << std::endl;

    const rocksolid::LoginResponse login_result = client.login_tcp_parsed(login_request);
    std::cout << "[TCP login] session=" << login_result.session_token << std::endl;

    const rocksolid::TokenValidationResult validation =
      client.validate_license_token_online(login_result.license_token);
    std::cout << "[Token validation] kid=" << validation.key_id
              << " valid=" << (validation.valid ? "true" : "false") << std::endl;
    std::cout << validation.payload_json << std::endl;
  } catch (const std::exception& error) {
    std::cerr << "RockSolid demo failed: " << error.what() << std::endl;
    return 1;
  }

  return 0;
}

#endif
