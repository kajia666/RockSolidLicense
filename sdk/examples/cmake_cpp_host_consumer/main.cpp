#include "rocksolid_transport_win.hpp"

#include <cctype>
#include <fstream>
#include <iostream>
#include <map>
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
  std::string http_host = "127.0.0.1";
  int http_port = 3000;
  bool http_secure = false;
  bool tcp_enabled = true;
  std::string tcp_host = "127.0.0.1";
  int tcp_port = 4000;
  bool include_token_keys = true;
  bool require_startup_bootstrap = true;
  bool require_local_token_validation = true;
  bool require_heartbeat_gate = true;
  bool run_network_demo = false;
  std::string username = "demo_user";
  std::string password = "demo_password";
  std::string device_name = "Demo Workstation";
};

void set_feature_gate(FeatureGate& gate, bool enabled, const std::string& reason) {
  gate.protected_features_enabled = enabled;
  gate.reason = reason;
  std::cout << "[gate] protected="
            << (enabled ? "true" : "false")
            << " reason=" << reason << std::endl;
}

std::string trim_copy(std::string value) {
  auto is_space = [](unsigned char ch) {
    return std::isspace(ch) != 0;
  };

  while (!value.empty() && is_space(static_cast<unsigned char>(value.front()))) {
    value.erase(value.begin());
  }
  while (!value.empty() && is_space(static_cast<unsigned char>(value.back()))) {
    value.pop_back();
  }
  return value;
}

bool parse_bool(const std::string& value, bool fallback) {
  std::string normalized;
  normalized.reserve(value.size());
  for (char ch : value) {
    normalized.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
  }
  if (normalized == "true" || normalized == "1" || normalized == "yes" || normalized == "on") {
    return true;
  }
  if (normalized == "false" || normalized == "0" || normalized == "no" || normalized == "off") {
    return false;
  }
  return fallback;
}

int parse_int(const std::string& value, int fallback) {
  try {
    return std::stoi(value);
  } catch (...) {
    return fallback;
  }
}

std::map<std::string, std::string> load_env_file(const std::string& path) {
  std::ifstream input(path);
  std::map<std::string, std::string> values;
  if (!input) {
    return values;
  }

  std::string line;
  while (std::getline(input, line)) {
    line = trim_copy(line);
    if (line.empty() || line[0] == '#') {
      continue;
    }
    const std::size_t separator = line.find('=');
    if (separator == std::string::npos) {
      continue;
    }
    const std::string key = trim_copy(line.substr(0, separator));
    const std::string value = trim_copy(line.substr(separator + 1));
    if (!key.empty()) {
      values[key] = value;
    }
  }

  return values;
}

HostConfig load_config_from_env_file(const std::string& path) {
  HostConfig config;
  const std::map<std::string, std::string> env = load_env_file(path);
  if (env.empty()) {
    return config;
  }

  auto read_string = [&](const char* key, std::string& target) {
    const auto it = env.find(key);
    if (it != env.end() && !it->second.empty()) {
      target = it->second;
    }
  };

  auto read_bool = [&](const char* key, bool& target) {
    const auto it = env.find(key);
    if (it != env.end()) {
      target = parse_bool(it->second, target);
    }
  };

  auto read_int = [&](const char* key, int& target) {
    const auto it = env.find(key);
    if (it != env.end()) {
      target = parse_int(it->second, target);
    }
  };

  read_string("RS_SDK_APP_ID", config.sdk_app_id);
  read_string("RS_SDK_APP_SECRET", config.sdk_app_secret);
  read_string("RS_APP_SALT", config.app_salt);
  read_string("RS_PROJECT_CODE", config.product_code);
  read_string("RS_CLIENT_VERSION", config.client_version);
  read_string("RS_CHANNEL", config.channel);
  read_string("RS_HTTP_HOST", config.http_host);
  read_int("RS_HTTP_PORT", config.http_port);
  read_bool("RS_HTTP_SECURE", config.http_secure);
  read_bool("RS_TCP_ENABLED", config.tcp_enabled);
  read_string("RS_TCP_HOST", config.tcp_host);
  read_int("RS_TCP_PORT", config.tcp_port);
  read_bool("RS_INCLUDE_TOKEN_KEYS", config.include_token_keys);
  read_bool("RS_REQUIRE_STARTUP_BOOTSTRAP", config.require_startup_bootstrap);
  read_bool("RS_REQUIRE_LOCAL_TOKEN_VALIDATION", config.require_local_token_validation);
  read_bool("RS_REQUIRE_HEARTBEAT_GATE", config.require_heartbeat_gate);
  read_bool("RS_RUN_NETWORK_DEMO", config.run_network_demo);
  read_string("RS_DEMO_USERNAME", config.username);
  read_string("RS_DEMO_PASSWORD", config.password);
  read_string("RS_DEMO_DEVICE_NAME", config.device_name);

  const auto baseUrl = env.find("RS_HTTP_BASE_URL");
  if (baseUrl != env.end() && baseUrl->second.rfind("https://", 0) == 0) {
    config.http_secure = true;
  }

  return config;
}

rocksolid::LicenseClientWin build_client(const HostConfig& config) {
  rocksolid::ClientIdentity identity{
    config.sdk_app_id,
    config.sdk_app_secret,
    config.app_salt
  };

  rocksolid::HttpEndpoint http_endpoint;
  http_endpoint.host.assign(config.http_host.begin(), config.http_host.end());
  http_endpoint.port = config.http_port;
  http_endpoint.secure = config.http_secure;

  rocksolid::TcpEndpoint tcp_endpoint;
  tcp_endpoint.host = config.tcp_host;
  tcp_endpoint.port = config.tcp_port;

  return rocksolid::LicenseClientWin(identity, http_endpoint, tcp_endpoint);
}

}  // namespace host_app

int main() {
  try {
    const host_app::HostConfig config =
      host_app::load_config_from_env_file("rocksolid_host_config.env");
    rocksolid::LicenseClientWin client = host_app::build_client(config);
    host_app::FeatureGate gate;
    host_app::RuntimeSession runtime;

    std::cout << "sdk_version=" << rocksolid::sdk_version_string() << std::endl;
    host_app::set_feature_gate(gate, false, "startup_bootstrap_pending");

    if (!config.run_network_demo) {
      std::cout << "Host consumer skeleton is ready." << std::endl;
      std::cout << "Create rocksolid_host_config.env from rocksolid_host_config.env.example" << std::endl;
      std::cout << "or paste values from the integration package .env template, then set RS_RUN_NETWORK_DEMO=true." << std::endl;
      return 0;
    }

    const std::string device_fingerprint = client.generate_device_fingerprint();
    std::cout << "[config] startup="
              << (config.require_startup_bootstrap ? "required" : "recommended")
              << " tokenValidation="
              << (config.require_local_token_validation ? "required" : "optional")
              << " heartbeatGate="
              << (config.require_heartbeat_gate ? "required" : "optional")
              << " transport="
              << (config.tcp_enabled ? "tcp" : "http") << std::endl;

    const rocksolid::ClientStartupBootstrapResponse startup =
      client.startup_bootstrap_http({
        config.product_code,
        config.client_version,
        config.channel,
        config.include_token_keys
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

    if (config.tcp_enabled) {
      runtime.login = client.login_tcp_parsed({
        config.product_code,
        config.username,
        config.password,
        device_fingerprint,
        config.device_name,
        config.client_version,
        config.channel
      });
    } else {
      runtime.login = client.login_http_parsed({
        config.product_code,
        config.username,
        config.password,
        device_fingerprint,
        config.device_name,
        config.client_version,
        config.channel
      });
    }
    runtime.logged_in = true;

    const rocksolid::TokenValidationResult validation =
      rocksolid::LicenseClientWin::validate_license_token_with_bootstrap(
        runtime.login.license_token,
        runtime.startup_cache.bootstrap
      );
    if (config.require_local_token_validation && !validation.valid) {
      host_app::set_feature_gate(gate, false, "local_token_validation_failed");
      std::cerr << "licenseToken validation failed." << std::endl;
      return 1;
    }
    if (!config.require_local_token_validation) {
      std::cout << "[token] optional validation="
                << (validation.valid ? "true" : "false")
                << " key=" << validation.key_id << std::endl;
    }

    host_app::set_feature_gate(gate, true, "session_active");

    rocksolid::HeartbeatResponse heartbeat;
    if (config.tcp_enabled) {
      heartbeat = client.heartbeat_tcp_parsed({
        config.product_code,
        runtime.login.session_token,
        device_fingerprint,
        config.client_version,
        config.channel
      });
    } else {
      heartbeat = client.heartbeat_http_parsed({
        config.product_code,
        runtime.login.session_token,
        device_fingerprint,
        config.client_version,
        config.channel
      });
    }

    std::cout << "[heartbeat] status=" << heartbeat.status
              << " next=" << heartbeat.next_heartbeat_in_seconds << "s" << std::endl;
    if (config.require_heartbeat_gate && heartbeat.status != "active") {
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
