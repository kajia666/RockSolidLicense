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

struct DeviceProfileRequest {
  std::string machine_code;
  std::string machine_guid;
  std::string cpu_id;
  std::string disk_serial;
  std::string board_serial;
  std::string bios_serial;
  std::string mac_address;
  std::string installation_id;
  std::string public_ip;
  std::string local_ip;
};

struct CardLoginRequest {
  std::string product_code;
  std::string card_key;
  std::string device_fingerprint;
  std::string device_name;
  DeviceProfileRequest device_profile;
};

struct LoginRequest {
  std::string product_code;
  std::string username;
  std::string password;
  std::string device_fingerprint;
  std::string device_name;
  DeviceProfileRequest device_profile;
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

struct ResellerAllocationInfo {
  bool present = false;
  std::string id;
  std::string code;
  std::string name;
  std::string allocation_batch_code;
  std::string allocated_at;
};

struct RechargeResponse {
  std::string entitlement_id;
  std::string policy_name;
  std::string grant_type;
  bool has_points = false;
  int total_points = 0;
  int remaining_points = 0;
  std::string starts_at;
  std::string ends_at;
  ResellerAllocationInfo reseller;
};

struct SessionBindingInfo {
  std::string id;
  std::string mode;
  std::vector<std::string> match_fields;
  int released_sessions = 0;
};

struct SessionQuotaInfo {
  std::string grant_type = "duration";
  bool metered = false;
  int total_points = 0;
  int remaining_points = 0;
  int consumed_points = 0;
  int consumed_this_login = 0;
};

struct LoginResponse {
  std::string session_id;
  std::string session_token;
  std::string license_token;
  std::string expires_at;
  std::string auth_mode;
  int heartbeat_interval_seconds = 0;
  int heartbeat_timeout_seconds = 0;
  std::string device_id;
  std::string device_fingerprint;
  std::string device_name;
  std::string entitlement_id;
  std::string entitlement_policy_name;
  std::string entitlement_ends_at;
  std::string account_id;
  std::string account_username;
  std::string card_masked_key;
  SessionBindingInfo binding;
  SessionQuotaInfo quota;
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

struct ManagedAccountInfo {
  std::string id;
  std::string username;
};

struct ManagedEntitlementInfo {
  std::string id;
  std::string policy_name;
  std::string ends_at;
  std::string status;
};

struct BindingRecord {
  std::string id;
  std::string entitlement_id;
  std::string device_id;
  std::string status;
  std::string first_bound_at;
  std::string last_bound_at;
  std::string revoked_at;
  std::string fingerprint;
  std::string device_name;
  std::string last_seen_at;
  std::string last_seen_ip;
  std::vector<std::string> match_fields;
  JsonValue identity = JsonValue(JsonValue::Object{});
  std::string bind_request_ip;
  int active_session_count = 0;
};

struct UnbindPolicyInfo {
  bool allow_client_unbind = false;
  int client_unbind_limit = 0;
  int client_unbind_window_days = 0;
  int client_unbind_deduct_days = 0;
  int recent_client_unbinds = 0;
  int remaining_client_unbinds = 0;
  bool has_remaining_client_unbinds = false;
};

struct BindingsRequest {
  std::string product_code;
  std::string username;
  std::string password;
  std::string card_key;
};

struct UnbindRequest {
  std::string product_code;
  std::string username;
  std::string password;
  std::string card_key;
  std::string binding_id;
  std::string device_fingerprint;
  std::string reason;
};

struct BindingsResponse {
  std::string auth_mode;
  ManagedAccountInfo account;
  ManagedEntitlementInfo entitlement;
  std::vector<BindingRecord> bindings;
  UnbindPolicyInfo unbind_policy;
};

struct UnbindResponse {
  bool changed = false;
  int released_sessions = 0;
  BindingRecord binding;
  ManagedEntitlementInfo entitlement;
  UnbindPolicyInfo unbind_policy;
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
  TransportResult bindings_http(const BindingsRequest& request) const;
  TransportResult unbind_http(const UnbindRequest& request) const;
  TransportResult card_login_http(const CardLoginRequest& request) const;
  TransportResult login_http(const LoginRequest& request) const;
  TransportResult heartbeat_http(const HeartbeatRequest& request) const;
  TransportResult logout_http(const LogoutRequest& request) const;

  TransportResult register_tcp(const RegisterRequest& request) const;
  TransportResult recharge_tcp(const RechargeRequest& request) const;
  TransportResult bindings_tcp(const BindingsRequest& request) const;
  TransportResult unbind_tcp(const UnbindRequest& request) const;
  TransportResult card_login_tcp(const CardLoginRequest& request) const;
  TransportResult login_tcp(const LoginRequest& request) const;
  TransportResult heartbeat_tcp(const HeartbeatRequest& request) const;
  TransportResult logout_tcp(const LogoutRequest& request) const;

  RegisterResponse register_http_parsed(const RegisterRequest& request) const;
  RechargeResponse recharge_http_parsed(const RechargeRequest& request) const;
  BindingsResponse bindings_http_parsed(const BindingsRequest& request) const;
  UnbindResponse unbind_http_parsed(const UnbindRequest& request) const;
  LoginResponse card_login_http_parsed(const CardLoginRequest& request) const;
  LoginResponse login_http_parsed(const LoginRequest& request) const;
  HeartbeatResponse heartbeat_http_parsed(const HeartbeatRequest& request) const;
  LogoutResponse logout_http_parsed(const LogoutRequest& request) const;

  RegisterResponse register_tcp_parsed(const RegisterRequest& request) const;
  RechargeResponse recharge_tcp_parsed(const RechargeRequest& request) const;
  BindingsResponse bindings_tcp_parsed(const BindingsRequest& request) const;
  UnbindResponse unbind_tcp_parsed(const UnbindRequest& request) const;
  LoginResponse card_login_tcp_parsed(const CardLoginRequest& request) const;
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
  static std::string to_json(const BindingsRequest& request);
  static std::string to_json(const UnbindRequest& request);
  static std::string to_json(const CardLoginRequest& request);
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
  static BindingsResponse parse_bindings_response(const ApiEnvelope& envelope);
  static UnbindResponse parse_unbind_response(const ApiEnvelope& envelope);
  static LoginResponse parse_login_response(const ApiEnvelope& envelope);
  static HeartbeatResponse parse_heartbeat_response(const ApiEnvelope& envelope);
  static LogoutResponse parse_logout_response(const ApiEnvelope& envelope);
};

}  // namespace rocksolid

#endif

#endif
