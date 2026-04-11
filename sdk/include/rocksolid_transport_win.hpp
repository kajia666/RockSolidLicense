#ifndef ROCKSOLID_TRANSPORT_WIN_HPP
#define ROCKSOLID_TRANSPORT_WIN_HPP

#ifdef _WIN32

#include "rocksolid_client.hpp"
#include "rocksolid_json.hpp"

#include <map>
#include <string>
#include <stdexcept>
#include <vector>

namespace rocksolid {

struct HttpEndpoint {
  std::wstring host = L"127.0.0.1";
  unsigned short port = 3000;
  bool secure = false;
  std::wstring user_agent = L"RockSolidLicenseSDK/0.1";
  unsigned int timeout_ms = 10000;
};

struct TcpEndpoint {
  std::string host = "127.0.0.1";
  unsigned short port = 4000;
  unsigned int timeout_ms = 10000;
};

struct ClientIdentity {
  std::string app_id;
  std::string app_secret;
  std::string app_salt;
};

struct TransportResult {
  long status_code = 0;
  std::string response_body;
};

struct ApiError {
  long status = 0;
  std::string code;
  std::string message;
  JsonValue details;
};

struct ApiEnvelope {
  long transport_status = 0;
  bool ok = false;
  std::string raw_body;
  JsonValue root;
  JsonValue data;
  JsonValue error;
};

struct TokenKeyInfo {
  std::string key_id;
  std::string algorithm;
  std::string issuer;
  std::string public_key_fingerprint;
  std::string public_key_pem;
  std::string status;
  std::string created_at;
};

struct TokenKeySet {
  std::string algorithm;
  std::string issuer;
  std::string active_key_id;
  std::vector<TokenKeyInfo> keys;
};

struct RegisterRequest {
  std::string product_code;
  std::string username;
  std::string password;
};

struct RechargeRequest {
  std::string product_code;
  std::string username;
  std::string password;
  std::string card_key;
};

struct LoginRequest {
  std::string product_code;
  std::string username;
  std::string password;
  std::string device_fingerprint;
  std::string device_name;
};

struct HeartbeatRequest {
  std::string product_code;
  std::string session_token;
  std::string device_fingerprint;
};

struct LogoutRequest {
  std::string product_code;
  std::string session_token;
};

struct RegisterResponse {
  std::string account_id;
  std::string product_code;
  std::string username;
};

struct RechargeResponse {
  std::string entitlement_id;
  std::string policy_name;
  std::string starts_at;
  std::string ends_at;
};

struct LoginResponse {
  std::string session_id;
  std::string session_token;
  std::string license_token;
  std::string expires_at;
  int heartbeat_interval_seconds = 0;
  int heartbeat_timeout_seconds = 0;
  std::string device_id;
  std::string device_fingerprint;
  std::string device_name;
  std::string entitlement_id;
  std::string entitlement_policy_name;
  std::string entitlement_ends_at;
};

struct HeartbeatResponse {
  std::string status;
  std::string account;
  std::string expires_at;
  int next_heartbeat_in_seconds = 0;
};

struct LogoutResponse {
  std::string status;
};

struct TokenValidationResult {
  bool valid = false;
  std::string key_id;
  std::string payload_json;
  JsonValue payload;
};

class HttpTransportWin {
 public:
  explicit HttpTransportWin(HttpEndpoint endpoint);

  TransportResult post_json(const SignedRequest& request) const;
  TransportResult get_json(const std::string& path) const;

 private:
  HttpEndpoint endpoint_;
};

class TcpTransportWin {
 public:
  explicit TcpTransportWin(TcpEndpoint endpoint);

  TransportResult call(const TcpFrame& frame) const;

 private:
  TcpEndpoint endpoint_;
};

class LicenseClientWin {
 public:
  LicenseClientWin(ClientIdentity identity, HttpEndpoint http_endpoint, TcpEndpoint tcp_endpoint);

  std::string generate_device_fingerprint() const;

  TransportResult register_http(const RegisterRequest& request) const;
  TransportResult recharge_http(const RechargeRequest& request) const;
  TransportResult login_http(const LoginRequest& request) const;
  TransportResult heartbeat_http(const HeartbeatRequest& request) const;
  TransportResult logout_http(const LogoutRequest& request) const;

  TransportResult register_tcp(const RegisterRequest& request) const;
  TransportResult recharge_tcp(const RechargeRequest& request) const;
  TransportResult login_tcp(const LoginRequest& request) const;
  TransportResult heartbeat_tcp(const HeartbeatRequest& request) const;
  TransportResult logout_tcp(const LogoutRequest& request) const;

  RegisterResponse register_http_parsed(const RegisterRequest& request) const;
  RechargeResponse recharge_http_parsed(const RechargeRequest& request) const;
  LoginResponse login_http_parsed(const LoginRequest& request) const;
  HeartbeatResponse heartbeat_http_parsed(const HeartbeatRequest& request) const;
  LogoutResponse logout_http_parsed(const LogoutRequest& request) const;

  RegisterResponse register_tcp_parsed(const RegisterRequest& request) const;
  RechargeResponse recharge_tcp_parsed(const RechargeRequest& request) const;
  LoginResponse login_tcp_parsed(const LoginRequest& request) const;
  HeartbeatResponse heartbeat_tcp_parsed(const HeartbeatRequest& request) const;
  LogoutResponse logout_tcp_parsed(const LogoutRequest& request) const;

  TokenKeyInfo fetch_active_token_key() const;
  TokenKeySet fetch_token_keys() const;
  TokenValidationResult validate_license_token_online(const std::string& token) const;

  SignedRequest make_signed_http_request(
    const std::string& path,
    const std::string& body
  ) const;

  TcpFrame make_signed_tcp_frame(
    const std::string& action,
    const std::string& path,
    const std::string& body
  ) const;

  static std::string to_json(const RegisterRequest& request);
  static std::string to_json(const RechargeRequest& request);
  static std::string to_json(const LoginRequest& request);
  static std::string to_json(const HeartbeatRequest& request);
  static std::string to_json(const LogoutRequest& request);
  static ApiEnvelope parse_api_envelope(const TransportResult& result);

 private:
  ClientIdentity identity_;
  HttpTransportWin http_;
  TcpTransportWin tcp_;

  static std::string require_not_empty(const char* field_name, const std::string& value);
  static std::string require_json_string(const JsonValue& object, const char* key);
  static int require_json_int(const JsonValue& object, const char* key);
  static const JsonValue& require_json_object(const JsonValue& object, const char* key);
  static ApiError parse_api_error(const JsonValue& error);
  static TokenKeyInfo parse_token_key_info(const JsonValue& object, const std::string& issuer);
  static TokenKeySet parse_token_key_set(const ApiEnvelope& envelope);
  static RegisterResponse parse_register_response(const ApiEnvelope& envelope);
  static RechargeResponse parse_recharge_response(const ApiEnvelope& envelope);
  static LoginResponse parse_login_response(const ApiEnvelope& envelope);
  static HeartbeatResponse parse_heartbeat_response(const ApiEnvelope& envelope);
  static LogoutResponse parse_logout_response(const ApiEnvelope& envelope);
};

}  // namespace rocksolid

#endif

#endif
