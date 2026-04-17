#ifdef _WIN32

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <winhttp.h>

#include "../include/rocksolid_transport_win.hpp"

#include <fstream>
#include <memory>
#include <sstream>
#include <type_traits>
#include <vector>

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "ws2_32.lib")

namespace rocksolid {
namespace {

class HandleCloser {
 public:
  void operator()(HINTERNET handle) const {
    if (handle != nullptr) {
      WinHttpCloseHandle(handle);
    }
  }
};

using HttpHandle = std::unique_ptr<std::remove_pointer<HINTERNET>::type, HandleCloser>;

std::wstring utf8_to_wide(const std::string& input) {
  if (input.empty()) {
    return std::wstring();
  }

  const int required = MultiByteToWideChar(
    CP_UTF8,
    0,
    input.data(),
    static_cast<int>(input.size()),
    nullptr,
    0
  );

  if (required <= 0) {
    throw std::runtime_error("utf8_to_wide failed");
  }

  std::wstring output(static_cast<size_t>(required), L'\0');
  const int converted = MultiByteToWideChar(
    CP_UTF8,
    0,
    input.data(),
    static_cast<int>(input.size()),
    output.data(),
    required
  );

  if (converted != required) {
    throw std::runtime_error("utf8_to_wide conversion mismatch");
  }

  return output;
}

std::string format_http_headers(const SignedHeaders& headers) {
  std::ostringstream stream;
  stream
    << "Content-Type: application/json\r\n"
    << "x-rs-app-id: " << headers.app_id << "\r\n"
    << "x-rs-timestamp: " << headers.timestamp << "\r\n"
    << "x-rs-nonce: " << headers.nonce << "\r\n"
    << "x-rs-signature: " << headers.signature << "\r\n";
  return stream.str();
}

void send_all(SOCKET socket, const std::string& data) {
  size_t total_sent = 0;
  while (total_sent < data.size()) {
    const int sent = send(
      socket,
      data.data() + total_sent,
      static_cast<int>(data.size() - total_sent),
      0
    );

    if (sent == SOCKET_ERROR) {
      throw std::runtime_error("TCP send failed");
    }
    total_sent += static_cast<size_t>(sent);
  }
}

class WsaSession {
 public:
  WsaSession() {
    WSADATA data{};
    const int status = WSAStartup(MAKEWORD(2, 2), &data);
    if (status != 0) {
      throw std::runtime_error("WSAStartup failed");
    }
  }

  ~WsaSession() {
    WSACleanup();
  }

  WsaSession(const WsaSession&) = delete;
  WsaSession& operator=(const WsaSession&) = delete;
};

struct AddrInfoDeleter {
  void operator()(addrinfo* value) const {
    if (value != nullptr) {
      freeaddrinfo(value);
    }
  }
};

std::string read_line(SOCKET socket) {
  std::string buffer;
  char chunk[512] = {0};

  while (true) {
    const int received = recv(socket, chunk, sizeof(chunk), 0);
    if (received == SOCKET_ERROR) {
      throw std::runtime_error("TCP recv failed");
    }
    if (received == 0) {
      break;
    }

    buffer.append(chunk, chunk + received);
    const auto newline = buffer.find('\n');
    if (newline != std::string::npos) {
      buffer.resize(newline);
      break;
    }
  }

  return buffer;
}

std::string build_json_pair(const char* key, const std::string& value) {
  std::ostringstream stream;
  stream
    << "\""
    << key
    << "\":\""
    << escape_json(value)
    << "\"";
  return stream.str();
}

void append_json_pair_if_present(
  std::vector<std::string>& parts,
  const char* key,
  const std::string& value
) {
  if (!value.empty()) {
    parts.push_back(build_json_pair(key, value));
  }
}

std::string build_device_profile_json(const DeviceProfileRequest& profile) {
  std::vector<std::string> parts;
  append_json_pair_if_present(parts, "machineCode", profile.machine_code);
  append_json_pair_if_present(parts, "machineGuid", profile.machine_guid);
  append_json_pair_if_present(parts, "cpuId", profile.cpu_id);
  append_json_pair_if_present(parts, "diskSerial", profile.disk_serial);
  append_json_pair_if_present(parts, "boardSerial", profile.board_serial);
  append_json_pair_if_present(parts, "biosSerial", profile.bios_serial);
  append_json_pair_if_present(parts, "macAddress", profile.mac_address);
  append_json_pair_if_present(parts, "installationId", profile.installation_id);
  append_json_pair_if_present(parts, "publicIp", profile.public_ip);
  append_json_pair_if_present(parts, "localIp", profile.local_ip);

  if (parts.empty()) {
    return std::string();
  }

  std::ostringstream stream;
  stream << "{";
  for (size_t index = 0; index < parts.size(); index += 1) {
    if (index > 0) {
      stream << ",";
    }
    stream << parts[index];
  }
  stream << "}";
  return stream.str();
}

const JsonValue* find_json_value(const JsonValue& object, const char* key) {
  if (!object.is_object() || !object.has(key)) {
    return nullptr;
  }
  return &object.at(key);
}

std::string require_object_string(const JsonValue& object, const char* key) {
  const JsonValue* value = find_json_value(object, key);
  if (!value || !value->is_string()) {
    throw std::runtime_error(std::string("Expected string field: ") + key);
  }
  return value->as_string();
}

int require_object_int(const JsonValue& object, const char* key) {
  const JsonValue* value = find_json_value(object, key);
  if (!value || !value->is_number()) {
    throw std::runtime_error(std::string("Expected numeric field: ") + key);
  }
  return static_cast<int>(value->as_number());
}

std::string optional_object_string(
  const JsonValue& object,
  const char* key,
  const std::string& fallback = std::string()
) {
  const JsonValue* value = find_json_value(object, key);
  if (!value || value->is_null()) {
    return fallback;
  }
  if (!value->is_string()) {
    throw std::runtime_error(std::string("Expected string field: ") + key);
  }
  return value->as_string();
}

int optional_object_int(const JsonValue& object, const char* key, int fallback = 0) {
  const JsonValue* value = find_json_value(object, key);
  if (!value || value->is_null()) {
    return fallback;
  }
  if (!value->is_number()) {
    throw std::runtime_error(std::string("Expected numeric field: ") + key);
  }
  return static_cast<int>(value->as_number());
}

bool optional_object_bool(const JsonValue& object, const char* key, bool fallback = false) {
  const JsonValue* value = find_json_value(object, key);
  if (!value || value->is_null()) {
    return fallback;
  }
  if (!value->is_bool()) {
    throw std::runtime_error(std::string("Expected boolean field: ") + key);
  }
  return value->as_bool();
}

const JsonValue* optional_object_value(const JsonValue& object, const char* key) {
  const JsonValue* value = find_json_value(object, key);
  if (!value || value->is_null()) {
    return nullptr;
  }
  return value;
}

const JsonValue& require_object_field(const JsonValue& object, const char* key, JsonType expected_type) {
  const JsonValue* value = find_json_value(object, key);
  if (!value) {
    throw std::runtime_error(std::string("Missing field: ") + key);
  }
  if (value->type() != expected_type) {
    throw std::runtime_error(std::string("Unexpected JSON type for field: ") + key);
  }
  return *value;
}

std::vector<std::string> parse_string_array(const JsonValue& value, const char* field_name) {
  if (!value.is_array()) {
    throw std::runtime_error(std::string("Expected array field: ") + field_name);
  }

  std::vector<std::string> output;
  for (const JsonValue& item : value.as_array()) {
    if (!item.is_string()) {
      throw std::runtime_error(std::string("Expected string items in field: ") + field_name);
    }
    output.push_back(item.as_string());
  }
  return output;
}

std::vector<std::string> optional_object_string_array(const JsonValue& object, const char* key) {
  const JsonValue* value = optional_object_value(object, key);
  if (!value) {
    return {};
  }
  return parse_string_array(*value, key);
}

ResellerAllocationInfo parse_reseller_allocation_info(const JsonValue& object) {
  ResellerAllocationInfo info;
  info.present = true;
  info.id = require_object_string(object, "id");
  info.code = require_object_string(object, "code");
  info.name = require_object_string(object, "name");
  info.allocation_batch_code = optional_object_string(object, "allocationBatchCode");
  info.allocated_at = optional_object_string(object, "allocatedAt");
  return info;
}

SessionBindingInfo parse_session_binding_info(const JsonValue& object) {
  SessionBindingInfo binding;
  binding.id = require_object_string(object, "id");
  binding.mode = require_object_string(object, "mode");
  binding.match_fields = optional_object_string_array(object, "matchFields");
  binding.released_sessions = optional_object_int(object, "releasedSessions", 0);
  return binding;
}

SessionQuotaInfo parse_session_quota_info(const JsonValue& object) {
  SessionQuotaInfo quota;
  quota.grant_type = optional_object_string(object, "grantType", "duration");
  quota.total_points = optional_object_int(object, "totalPoints", 0);
  quota.remaining_points = optional_object_int(object, "remainingPoints", 0);
  quota.consumed_points = optional_object_int(object, "consumedPoints", 0);
  quota.consumed_this_login = optional_object_int(object, "consumedThisLogin", 0);
  quota.metered = quota.grant_type == "points";
  return quota;
}

ManagedAccountInfo parse_managed_account_info(const JsonValue& object) {
  ManagedAccountInfo account;
  account.id = require_object_string(object, "id");
  account.username = require_object_string(object, "username");
  return account;
}

ManagedEntitlementInfo parse_managed_entitlement_info(
  const JsonValue& object,
  bool require_policy_name
) {
  ManagedEntitlementInfo entitlement;
  entitlement.id = require_object_string(object, "id");
  entitlement.policy_name = require_policy_name
    ? require_object_string(object, "policyName")
    : optional_object_string(object, "policyName");
  entitlement.ends_at = require_object_string(object, "endsAt");
  entitlement.status = optional_object_string(object, "status");
  return entitlement;
}

BindingRecord parse_binding_record(const JsonValue& object) {
  BindingRecord binding;
  binding.id = require_object_string(object, "id");
  binding.entitlement_id = require_object_string(object, "entitlementId");
  binding.device_id = require_object_string(object, "deviceId");
  binding.status = require_object_string(object, "status");
  binding.first_bound_at = require_object_string(object, "firstBoundAt");
  binding.last_bound_at = require_object_string(object, "lastBoundAt");
  binding.revoked_at = optional_object_string(object, "revokedAt");
  binding.fingerprint = require_object_string(object, "fingerprint");
  binding.device_name = optional_object_string(object, "deviceName");
  binding.last_seen_at = optional_object_string(object, "lastSeenAt");
  binding.last_seen_ip = optional_object_string(object, "lastSeenIp");
  binding.match_fields = optional_object_string_array(object, "matchFields");
  if (const JsonValue* identity = optional_object_value(object, "identity")) {
    binding.identity = *identity;
  }
  binding.bind_request_ip = optional_object_string(object, "bindRequestIp");
  binding.active_session_count = optional_object_int(object, "activeSessionCount", 0);
  return binding;
}

UnbindPolicyInfo parse_unbind_policy_info(const JsonValue& object) {
  UnbindPolicyInfo policy;
  policy.allow_client_unbind = optional_object_bool(object, "allowClientUnbind", false);
  policy.client_unbind_limit = optional_object_int(object, "clientUnbindLimit", 0);
  policy.client_unbind_window_days = optional_object_int(object, "clientUnbindWindowDays", 0);
  policy.client_unbind_deduct_days = optional_object_int(object, "clientUnbindDeductDays", 0);
  policy.recent_client_unbinds = optional_object_int(object, "recentClientUnbinds", 0);
  const JsonValue* remaining = optional_object_value(object, "remainingClientUnbinds");
  if (remaining && remaining->is_number()) {
    policy.has_remaining_client_unbinds = true;
    policy.remaining_client_unbinds = static_cast<int>(remaining->as_number());
  }
  return policy;
}

NoticeInfo parse_notice_info(const JsonValue& object) {
  NoticeInfo notice;
  notice.id = require_object_string(object, "id");
  notice.product_code = optional_object_string(object, "productCode");
  notice.product_name = optional_object_string(object, "productName");
  notice.channel = require_object_string(object, "channel");
  notice.kind = require_object_string(object, "kind");
  notice.severity = require_object_string(object, "severity");
  notice.title = require_object_string(object, "title");
  notice.body = require_object_string(object, "body");
  notice.action_url = optional_object_string(object, "actionUrl");
  notice.status = require_object_string(object, "status");
  notice.block_login = optional_object_bool(object, "blockLogin", false);
  notice.starts_at = require_object_string(object, "startsAt");
  notice.ends_at = optional_object_string(object, "endsAt");
  notice.created_at = require_object_string(object, "createdAt");
  notice.updated_at = require_object_string(object, "updatedAt");
  return notice;
}

ClientVersionNoticeInfo parse_client_version_notice_info(const JsonValue& object) {
  ClientVersionNoticeInfo notice;
  notice.present = true;
  notice.version = require_object_string(object, "version");
  notice.title = optional_object_string(object, "title");
  notice.body = optional_object_string(object, "body");
  notice.release_notes = optional_object_string(object, "releaseNotes");
  return notice;
}

ClientVersionSummary parse_client_version_summary(const JsonValue& object) {
  ClientVersionSummary version;
  version.id = require_object_string(object, "id");
  version.version = require_object_string(object, "version");
  version.channel = require_object_string(object, "channel");
  version.status = require_object_string(object, "status");
  version.force_update = optional_object_bool(object, "forceUpdate", false);
  version.download_url = optional_object_string(object, "downloadUrl");
  version.released_at = optional_object_string(object, "releasedAt");
  version.notice_title = optional_object_string(object, "noticeTitle");
  return version;
}

TokenKeyInfo parse_token_key_info_payload(const JsonValue& object, const std::string& issuer) {
  if (!object.is_object()) {
    throw std::runtime_error("Token key payload must be an object.");
  }

  TokenKeyInfo info;
  info.key_id = require_object_string(object, "keyId");
  info.algorithm = require_object_string(object, "algorithm");
  info.issuer = issuer.empty() ? optional_object_string(object, "issuer") : issuer;
  info.public_key_fingerprint = require_object_string(object, "publicKeyFingerprint");
  info.public_key_pem = require_object_string(object, "publicKeyPem");
  info.status = optional_object_string(object, "status", "active");
  info.created_at = optional_object_string(object, "createdAt");
  return info;
}

TokenKeySet parse_token_key_set_object(const JsonValue& object) {
  if (!object.is_object()) {
    throw std::runtime_error("Token key data must be an object.");
  }

  TokenKeySet key_set;
  key_set.algorithm = require_object_string(object, "algorithm");
  key_set.issuer = require_object_string(object, "issuer");
  key_set.active_key_id = object.has("activeKeyId") && object.at("activeKeyId").is_string()
    ? object.at("activeKeyId").as_string()
    : object.has("keyId") && object.at("keyId").is_string()
      ? object.at("keyId").as_string()
      : "";

  if (object.has("keys")) {
    const JsonValue& keys = object.at("keys");
    if (!keys.is_array()) {
      throw std::runtime_error("Token key set 'keys' must be an array.");
    }
    for (const JsonValue& item : keys.as_array()) {
      key_set.keys.push_back(parse_token_key_info_payload(item, key_set.issuer));
    }
  } else {
    key_set.keys.push_back(parse_token_key_info_payload(object, key_set.issuer));
  }

  return key_set;
}

ClientVersionManifestResponse parse_client_version_manifest_object(const JsonValue& object) {
  if (!object.is_object()) {
    throw std::runtime_error("Version-check response data must be an object.");
  }

  ClientVersionManifestResponse response;
  response.product_code = require_object_string(object, "productCode");
  response.channel = require_object_string(object, "channel");
  response.client_version = optional_object_string(object, "clientVersion");
  response.allowed = optional_object_bool(object, "allowed", false);
  response.status = require_object_string(object, "status");
  response.message = require_object_string(object, "message");
  response.latest_version = optional_object_string(object, "latestVersion");
  response.minimum_allowed_version = optional_object_string(object, "minimumAllowedVersion");
  response.latest_download_url = optional_object_string(object, "latestDownloadUrl");

  if (const JsonValue* notice = optional_object_value(object, "notice")) {
    if (!notice->is_object()) {
      throw std::runtime_error("Version-check notice payload must be an object.");
    }
    response.notice = parse_client_version_notice_info(*notice);
  }

  if (const JsonValue* versions = optional_object_value(object, "versions")) {
    if (!versions->is_array()) {
      throw std::runtime_error("Version-check versions payload must be an array.");
    }
    for (const JsonValue& item : versions->as_array()) {
      if (!item.is_object()) {
        throw std::runtime_error("Version-check versions items must be objects.");
      }
      response.versions.push_back(parse_client_version_summary(item));
    }
  }

  return response;
}

ClientNoticesResponse parse_client_notices_object(const JsonValue& object) {
  if (!object.is_object()) {
    throw std::runtime_error("Client notices response data must be an object.");
  }

  ClientNoticesResponse response;
  response.product_code = require_object_string(object, "productCode");
  response.channel = require_object_string(object, "channel");

  const JsonValue& notices = require_object_field(object, "notices", JsonType::array);
  for (const JsonValue& item : notices.as_array()) {
    if (!item.is_object()) {
      throw std::runtime_error("Client notices items must be objects.");
    }
    response.notices.push_back(parse_notice_info(item));
  }

  return response;
}

std::string json_string_literal(const std::string& value) {
  return "\"" + escape_json(value) + "\"";
}

std::string json_string_or_null(const std::string& value) {
  return value.empty() ? "null" : json_string_literal(value);
}

std::string json_bool_literal(bool value) {
  return value ? "true" : "false";
}

std::string json_int_literal(int value) {
  return std::to_string(value);
}

std::string serialize_notice_info_json(const NoticeInfo& notice) {
  std::ostringstream stream;
  stream
    << "{"
    << "\"id\":" << json_string_literal(notice.id) << ","
    << "\"productCode\":" << json_string_or_null(notice.product_code) << ","
    << "\"productName\":" << json_string_or_null(notice.product_name) << ","
    << "\"channel\":" << json_string_literal(notice.channel) << ","
    << "\"kind\":" << json_string_literal(notice.kind) << ","
    << "\"severity\":" << json_string_literal(notice.severity) << ","
    << "\"title\":" << json_string_literal(notice.title) << ","
    << "\"body\":" << json_string_literal(notice.body) << ","
    << "\"actionUrl\":" << json_string_or_null(notice.action_url) << ","
    << "\"status\":" << json_string_literal(notice.status) << ","
    << "\"blockLogin\":" << json_bool_literal(notice.block_login) << ","
    << "\"startsAt\":" << json_string_literal(notice.starts_at) << ","
    << "\"endsAt\":" << json_string_or_null(notice.ends_at) << ","
    << "\"createdAt\":" << json_string_literal(notice.created_at) << ","
    << "\"updatedAt\":" << json_string_literal(notice.updated_at)
    << "}";
  return stream.str();
}

std::string serialize_token_key_info_json(const TokenKeyInfo& key) {
  std::ostringstream stream;
  stream
    << "{"
    << "\"keyId\":" << json_string_literal(key.key_id) << ","
    << "\"algorithm\":" << json_string_literal(key.algorithm) << ","
    << "\"issuer\":" << json_string_or_null(key.issuer) << ","
    << "\"publicKeyFingerprint\":" << json_string_literal(key.public_key_fingerprint) << ","
    << "\"publicKeyPem\":" << json_string_literal(key.public_key_pem) << ","
    << "\"status\":" << json_string_or_null(key.status) << ","
    << "\"createdAt\":" << json_string_or_null(key.created_at)
    << "}";
  return stream.str();
}

std::string serialize_token_key_set_json(const TokenKeySet& key_set) {
  std::ostringstream stream;
  stream
    << "{"
    << "\"algorithm\":" << json_string_literal(key_set.algorithm) << ","
    << "\"issuer\":" << json_string_literal(key_set.issuer) << ","
    << "\"activeKeyId\":" << json_string_or_null(key_set.active_key_id) << ","
    << "\"keys\":[";
  for (size_t index = 0; index < key_set.keys.size(); index += 1) {
    if (index > 0) {
      stream << ",";
    }
    stream << serialize_token_key_info_json(key_set.keys[index]);
  }
  stream << "]}";
  return stream.str();
}

std::string serialize_client_version_notice_json(const ClientVersionNoticeInfo& notice) {
  if (!notice.present) {
    return "null";
  }

  std::ostringstream stream;
  stream
    << "{"
    << "\"version\":" << json_string_literal(notice.version) << ","
    << "\"title\":" << json_string_or_null(notice.title) << ","
    << "\"body\":" << json_string_or_null(notice.body) << ","
    << "\"releaseNotes\":" << json_string_or_null(notice.release_notes)
    << "}";
  return stream.str();
}

std::string serialize_client_version_summary_json(const ClientVersionSummary& version) {
  std::ostringstream stream;
  stream
    << "{"
    << "\"id\":" << json_string_literal(version.id) << ","
    << "\"version\":" << json_string_literal(version.version) << ","
    << "\"channel\":" << json_string_literal(version.channel) << ","
    << "\"status\":" << json_string_literal(version.status) << ","
    << "\"forceUpdate\":" << json_bool_literal(version.force_update) << ","
    << "\"downloadUrl\":" << json_string_or_null(version.download_url) << ","
    << "\"releasedAt\":" << json_string_or_null(version.released_at) << ","
    << "\"noticeTitle\":" << json_string_or_null(version.notice_title)
    << "}";
  return stream.str();
}

std::string serialize_client_version_manifest_json(const ClientVersionManifestResponse& manifest) {
  std::ostringstream stream;
  stream
    << "{"
    << "\"productCode\":" << json_string_literal(manifest.product_code) << ","
    << "\"channel\":" << json_string_literal(manifest.channel) << ","
    << "\"clientVersion\":" << json_string_or_null(manifest.client_version) << ","
    << "\"allowed\":" << json_bool_literal(manifest.allowed) << ","
    << "\"status\":" << json_string_literal(manifest.status) << ","
    << "\"message\":" << json_string_literal(manifest.message) << ","
    << "\"latestVersion\":" << json_string_or_null(manifest.latest_version) << ","
    << "\"minimumAllowedVersion\":" << json_string_or_null(manifest.minimum_allowed_version) << ","
    << "\"latestDownloadUrl\":" << json_string_or_null(manifest.latest_download_url) << ","
    << "\"notice\":" << serialize_client_version_notice_json(manifest.notice) << ","
    << "\"versions\":[";
  for (size_t index = 0; index < manifest.versions.size(); index += 1) {
    if (index > 0) {
      stream << ",";
    }
    stream << serialize_client_version_summary_json(manifest.versions[index]);
  }
  stream << "]}";
  return stream.str();
}

std::string serialize_client_notices_response_json(const ClientNoticesResponse& notices) {
  std::ostringstream stream;
  stream
    << "{"
    << "\"productCode\":" << json_string_literal(notices.product_code) << ","
    << "\"channel\":" << json_string_literal(notices.channel) << ","
    << "\"notices\":[";
  for (size_t index = 0; index < notices.notices.size(); index += 1) {
    if (index > 0) {
      stream << ",";
    }
    stream << serialize_notice_info_json(notices.notices[index]);
  }
  stream << "]}";
  return stream.str();
}

std::string serialize_client_startup_bootstrap_json(const ClientStartupBootstrapResponse& bootstrap) {
  std::ostringstream stream;
  stream
    << "{"
    << "\"versionManifest\":" << serialize_client_version_manifest_json(bootstrap.version_manifest) << ","
    << "\"notices\":" << serialize_client_notices_response_json(bootstrap.notices) << ","
    << "\"activeTokenKey\":" << serialize_token_key_info_json(bootstrap.active_token_key) << ","
    << "\"tokenKeys\":" << serialize_token_key_set_json(bootstrap.token_keys) << ","
    << "\"hasTokenKeys\":" << json_bool_literal(bootstrap.has_token_keys)
    << "}";
  return stream.str();
}

TokenValidationResult prepare_token_validation_result(const std::string& token) {
  TokenValidationResult result;
  result.payload_json = decode_license_token_payload(token);
  result.payload = JsonValue::parse(result.payload_json);
  if (!result.payload.is_object() || !result.payload.has("kid")) {
    throw std::runtime_error("License token payload does not contain a kid.");
  }

  if (!result.payload.at("kid").is_string()) {
    throw std::runtime_error("License token payload kid must be a string.");
  }

  result.key_id = result.payload.at("kid").as_string();
  return result;
}

TransportResult perform_http_request(
  const HttpEndpoint& endpoint,
  const wchar_t* method,
  const std::string& path,
  const std::string* header_block_utf8,
  const std::string* body
) {
  HttpHandle session(
    WinHttpOpen(
      endpoint.user_agent.c_str(),
      WINHTTP_ACCESS_TYPE_NO_PROXY,
      WINHTTP_NO_PROXY_NAME,
      WINHTTP_NO_PROXY_BYPASS,
      0
    )
  );
  if (!session) {
    throw std::runtime_error("WinHttpOpen failed");
  }

  WinHttpSetTimeouts(
    session.get(),
    static_cast<int>(endpoint.timeout_ms),
    static_cast<int>(endpoint.timeout_ms),
    static_cast<int>(endpoint.timeout_ms),
    static_cast<int>(endpoint.timeout_ms)
  );

  HttpHandle connect(
    WinHttpConnect(session.get(), endpoint.host.c_str(), endpoint.port, 0)
  );
  if (!connect) {
    throw std::runtime_error("WinHttpConnect failed");
  }

  const std::wstring wide_path = utf8_to_wide(path);
  const DWORD flags = endpoint.secure ? WINHTTP_FLAG_SECURE : 0;
  HttpHandle handle(
    WinHttpOpenRequest(
      connect.get(),
      method,
      wide_path.c_str(),
      nullptr,
      WINHTTP_NO_REFERER,
      WINHTTP_DEFAULT_ACCEPT_TYPES,
      flags
    )
  );
  if (!handle) {
    throw std::runtime_error("WinHttpOpenRequest failed");
  }

  const std::wstring headers = header_block_utf8 ? utf8_to_wide(*header_block_utf8) : std::wstring();
  LPVOID request_body = WINHTTP_NO_REQUEST_DATA;
  DWORD request_body_length = 0;
  if (body && !body->empty()) {
    request_body = const_cast<char*>(body->data());
    request_body_length = static_cast<DWORD>(body->size());
  }

  const BOOL sent = WinHttpSendRequest(
    handle.get(),
    header_block_utf8 ? headers.c_str() : WINHTTP_NO_ADDITIONAL_HEADERS,
    header_block_utf8 ? static_cast<DWORD>(headers.size()) : 0,
    request_body,
    request_body_length,
    request_body_length,
    0
  );
  if (!sent) {
    throw std::runtime_error("WinHttpSendRequest failed");
  }

  if (!WinHttpReceiveResponse(handle.get(), nullptr)) {
    throw std::runtime_error("WinHttpReceiveResponse failed");
  }

  DWORD status_code = 0;
  DWORD status_size = sizeof(status_code);
  if (!WinHttpQueryHeaders(
        handle.get(),
        WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX,
        &status_code,
        &status_size,
        WINHTTP_NO_HEADER_INDEX
      )) {
    throw std::runtime_error("WinHttpQueryHeaders failed");
  }

  std::string response_body;
  while (true) {
    DWORD available = 0;
    if (!WinHttpQueryDataAvailable(handle.get(), &available)) {
      throw std::runtime_error("WinHttpQueryDataAvailable failed");
    }
    if (available == 0) {
      break;
    }

    std::vector<char> chunk(available);
    DWORD read = 0;
    if (!WinHttpReadData(handle.get(), chunk.data(), available, &read)) {
      throw std::runtime_error("WinHttpReadData failed");
    }

    response_body.append(chunk.data(), chunk.data() + read);
  }

  return TransportResult{static_cast<long>(status_code), response_body};
}

}  // namespace

HttpTransportWin::HttpTransportWin(HttpEndpoint endpoint) : endpoint_(endpoint) {}

TransportResult HttpTransportWin::post_json(const SignedRequest& request) const {
  const std::string header_block_utf8 = format_http_headers(request.headers);
  return perform_http_request(endpoint_, L"POST", request.path, &header_block_utf8, &request.body);
}

TransportResult HttpTransportWin::get_json(const std::string& path) const {
  return perform_http_request(endpoint_, L"GET", path, nullptr, nullptr);
}

TcpTransportWin::TcpTransportWin(TcpEndpoint endpoint) : endpoint_(endpoint) {}

TransportResult TcpTransportWin::call(const TcpFrame& frame) const {
  WsaSession wsa_session;

  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_protocol = IPPROTO_TCP;

  addrinfo* raw_results = nullptr;
  const std::string port = std::to_string(endpoint_.port);
  const int resolved = getaddrinfo(endpoint_.host.c_str(), port.c_str(), &hints, &raw_results);
  if (resolved != 0) {
    throw std::runtime_error("getaddrinfo failed");
  }

  std::unique_ptr<addrinfo, AddrInfoDeleter> results(raw_results);
  SOCKET socket_handle = INVALID_SOCKET;

  for (addrinfo* current = results.get(); current != nullptr; current = current->ai_next) {
    socket_handle = socket(current->ai_family, current->ai_socktype, current->ai_protocol);
    if (socket_handle == INVALID_SOCKET) {
      continue;
    }

    const DWORD timeout = endpoint_.timeout_ms;
    setsockopt(
      socket_handle,
      SOL_SOCKET,
      SO_RCVTIMEO,
      reinterpret_cast<const char*>(&timeout),
      sizeof(timeout)
    );
    setsockopt(
      socket_handle,
      SOL_SOCKET,
      SO_SNDTIMEO,
      reinterpret_cast<const char*>(&timeout),
      sizeof(timeout)
    );

    if (connect(socket_handle, current->ai_addr, static_cast<int>(current->ai_addrlen)) == 0) {
      break;
    }

    closesocket(socket_handle);
    socket_handle = INVALID_SOCKET;
  }

  if (socket_handle == INVALID_SOCKET) {
    throw std::runtime_error("TCP connect failed");
  }

  const std::string wire = frame.to_json_line();
  send_all(socket_handle, wire);
  const std::string response = read_line(socket_handle);
  closesocket(socket_handle);

  return TransportResult{200, response};
}

ApiEnvelope LicenseClientWin::parse_api_envelope(const TransportResult& result) {
  ApiEnvelope envelope;
  envelope.transport_status = result.status_code;
  envelope.raw_body = result.response_body;
  envelope.root = JsonValue::parse(result.response_body);

  if (!envelope.root.is_object()) {
    throw std::runtime_error("API response root must be a JSON object.");
  }

  envelope.ok = envelope.root.has("ok") && envelope.root.at("ok").is_bool()
    ? envelope.root.at("ok").as_bool()
    : false;

  if (envelope.root.has("data")) {
    envelope.data = envelope.root.at("data");
  }
  if (envelope.root.has("error")) {
    envelope.error = envelope.root.at("error");
  }

  return envelope;
}

ApiError LicenseClientWin::parse_api_error(const JsonValue& error) {
  if (!error.is_object()) {
    return ApiError{0, 0, "INVALID_ERROR", "Malformed API error payload.", JsonValue()};
  }

  ApiError parsed;
  if (error.has("status") && error.at("status").is_number()) {
    parsed.status = json_number_to_long(error.at("status"));
  }
  if (error.has("code") && error.at("code").is_string()) {
    parsed.code = error.at("code").as_string();
  }
  if (error.has("message") && error.at("message").is_string()) {
    parsed.message = error.at("message").as_string();
  }
  if (error.has("details")) {
    parsed.details = error.at("details");
  }
  return parsed;
}

void LicenseClientWin::throw_api_exception(const ApiEnvelope& envelope, const char* fallback_message) {
  ApiError error = parse_api_error(envelope.error);
  error.transport_status = envelope.transport_status;
  if (error.status == 0) {
    error.status = envelope.transport_status;
  }
  if (error.code.empty()) {
    error.code = "API_REQUEST_FAILED";
  }
  if (error.message.empty()) {
    error.message = fallback_message == nullptr ? "API request failed." : std::string(fallback_message);
  }
  throw ApiException(error);
}

std::string LicenseClientWin::require_json_string(const JsonValue& object, const char* key) {
  const JsonValue& value = object.at(key);
  if (!value.is_string()) {
    throw std::runtime_error(std::string("Expected string field: ") + key);
  }
  return value.as_string();
}

int LicenseClientWin::require_json_int(const JsonValue& object, const char* key) {
  const JsonValue& value = object.at(key);
  if (!value.is_number()) {
    throw std::runtime_error(std::string("Expected numeric field: ") + key);
  }
  return static_cast<int>(value.as_number());
}

const JsonValue& LicenseClientWin::require_json_object(const JsonValue& object, const char* key) {
  const JsonValue& value = object.at(key);
  if (!value.is_object()) {
    throw std::runtime_error(std::string("Expected object field: ") + key);
  }
  return value;
}

TokenKeyInfo LicenseClientWin::parse_token_key_info(const JsonValue& object, const std::string& issuer) {
  return parse_token_key_info_payload(object, issuer);
}

TokenKeySet LicenseClientWin::parse_token_key_set(const ApiEnvelope& envelope) {
  if (!envelope.ok) {
    throw_api_exception(envelope, "Token key request failed.");
  }
  return parse_token_key_set_object(envelope.data);
}

TokenKeyInfo LicenseClientWin::select_active_token_key(const TokenKeySet& key_set) {
  if (key_set.keys.empty()) {
    throw std::runtime_error("Token key set did not contain any keys.");
  }

  if (!key_set.active_key_id.empty()) {
    for (const TokenKeyInfo& key : key_set.keys) {
      if (key.key_id == key_set.active_key_id) {
        return key;
      }
    }
  }

  return key_set.keys.front();
}

RegisterResponse LicenseClientWin::parse_register_response(const ApiEnvelope& envelope) {
  if (!envelope.ok) {
    throw_api_exception(envelope, "Register request failed.");
  }

  RegisterResponse response;
  response.account_id = require_json_string(envelope.data, "accountId");
  response.product_code = require_json_string(envelope.data, "productCode");
  response.username = require_json_string(envelope.data, "username");
  return response;
}

RechargeResponse LicenseClientWin::parse_recharge_response(const ApiEnvelope& envelope) {
  if (!envelope.ok) {
    throw_api_exception(envelope, "Recharge request failed.");
  }

  RechargeResponse response;
  response.entitlement_id = require_json_string(envelope.data, "entitlementId");
  response.policy_name = require_json_string(envelope.data, "policyName");
  response.grant_type = envelope.data.has("grantType") && envelope.data.at("grantType").is_string()
    ? envelope.data.at("grantType").as_string()
    : "duration";
  if (response.grant_type == "points") {
    response.has_points = true;
    response.total_points = optional_object_int(envelope.data, "totalPoints", 0);
    response.remaining_points = optional_object_int(envelope.data, "remainingPoints", 0);
  }
  response.starts_at = require_json_string(envelope.data, "startsAt");
  response.ends_at = require_json_string(envelope.data, "endsAt");
  if (const JsonValue* reseller = optional_object_value(envelope.data, "reseller")) {
    if (!reseller->is_object()) {
      throw std::runtime_error("Recharge reseller payload must be an object.");
    }
    response.reseller = parse_reseller_allocation_info(*reseller);
  }
  return response;
}

BindingsResponse LicenseClientWin::parse_bindings_response(const ApiEnvelope& envelope) {
  if (!envelope.ok) {
    throw_api_exception(envelope, "Bindings request failed.");
  }
  if (!envelope.data.is_object()) {
    throw std::runtime_error("Bindings response data must be an object.");
  }

  BindingsResponse response;
  response.auth_mode = optional_object_string(envelope.data, "authMode", "account");

  const JsonValue& account = require_object_field(envelope.data, "account", JsonType::object);
  response.account = parse_managed_account_info(account);

  const JsonValue& entitlement = require_object_field(envelope.data, "entitlement", JsonType::object);
  response.entitlement = parse_managed_entitlement_info(entitlement, true);

  const JsonValue& bindings = require_object_field(envelope.data, "bindings", JsonType::array);
  for (const JsonValue& item : bindings.as_array()) {
    if (!item.is_object()) {
      throw std::runtime_error("Binding list items must be objects.");
    }
    response.bindings.push_back(parse_binding_record(item));
  }

  const JsonValue& unbind_policy = require_object_field(envelope.data, "unbindPolicy", JsonType::object);
  response.unbind_policy = parse_unbind_policy_info(unbind_policy);
  return response;
}

UnbindResponse LicenseClientWin::parse_unbind_response(const ApiEnvelope& envelope) {
  if (!envelope.ok) {
    throw_api_exception(envelope, "Unbind request failed.");
  }
  if (!envelope.data.is_object()) {
    throw std::runtime_error("Unbind response data must be an object.");
  }

  UnbindResponse response;
  response.changed = envelope.data.has("changed") && envelope.data.at("changed").is_bool()
    ? envelope.data.at("changed").as_bool()
    : false;
  response.released_sessions = optional_object_int(envelope.data, "releasedSessions", 0);

  const JsonValue& binding = require_object_field(envelope.data, "binding", JsonType::object);
  response.binding = parse_binding_record(binding);

  const JsonValue& entitlement = require_object_field(envelope.data, "entitlement", JsonType::object);
  response.entitlement = parse_managed_entitlement_info(entitlement, false);

  if (const JsonValue* unbind_policy = optional_object_value(envelope.data, "unbindPolicy")) {
    if (!unbind_policy->is_object()) {
      throw std::runtime_error("Unbind policy payload must be an object.");
    }
    response.unbind_policy = parse_unbind_policy_info(*unbind_policy);
  }

  return response;
}

ClientVersionManifestResponse LicenseClientWin::parse_version_check_response(const ApiEnvelope& envelope) {
  if (!envelope.ok) {
    throw_api_exception(envelope, "Version-check request failed.");
  }
  return parse_client_version_manifest_object(envelope.data);
}

ClientNoticesResponse LicenseClientWin::parse_notices_response(const ApiEnvelope& envelope) {
  if (!envelope.ok) {
    throw_api_exception(envelope, "Client notices request failed.");
  }
  return parse_client_notices_object(envelope.data);
}

ClientStartupBootstrapResponse LicenseClientWin::parse_startup_bootstrap_response(
  const ApiEnvelope& envelope
) {
  if (!envelope.ok) {
    throw_api_exception(envelope, "Client startup bootstrap failed.");
  }

  const JsonValue& object = envelope.data;
  ClientStartupBootstrapResponse bootstrap;
  bootstrap.version_manifest = parse_client_version_manifest_object(
    require_object_field(object, "versionManifest", JsonType::object)
  );
  bootstrap.notices = parse_client_notices_object(
    require_object_field(object, "notices", JsonType::object)
  );
  bootstrap.active_token_key = parse_token_key_info_payload(
    require_object_field(object, "activeTokenKey", JsonType::object),
    ""
  );
  if (const JsonValue* token_keys = optional_object_value(object, "tokenKeys")) {
    bootstrap.token_keys = parse_token_key_set_object(*token_keys);
  }
  bootstrap.has_token_keys = optional_object_bool(object, "hasTokenKeys", false);
  return bootstrap;
}

LoginResponse LicenseClientWin::parse_login_response(const ApiEnvelope& envelope) {
  if (!envelope.ok) {
    throw_api_exception(envelope, "Login request failed.");
  }

  LoginResponse response;
  response.session_id = require_json_string(envelope.data, "sessionId");
  response.session_token = require_json_string(envelope.data, "sessionToken");
  response.license_token = require_json_string(envelope.data, "licenseToken");
  response.expires_at = require_json_string(envelope.data, "expiresAt");
  response.auth_mode = envelope.data.has("authMode") && envelope.data.at("authMode").is_string()
    ? envelope.data.at("authMode").as_string()
    : "account";

  const JsonValue& heartbeat = require_json_object(envelope.data, "heartbeat");
  response.heartbeat_interval_seconds = require_json_int(heartbeat, "intervalSeconds");
  response.heartbeat_timeout_seconds = require_json_int(heartbeat, "timeoutSeconds");

  const JsonValue& device = require_json_object(envelope.data, "device");
  response.device_id = require_json_string(device, "id");
  response.device_fingerprint = require_json_string(device, "fingerprint");
  response.device_name = require_json_string(device, "name");

  const JsonValue& entitlement = require_json_object(envelope.data, "entitlement");
  response.entitlement_id = require_json_string(entitlement, "id");
  response.entitlement_policy_name = require_json_string(entitlement, "policyName");
  response.entitlement_ends_at = require_json_string(entitlement, "endsAt");
  response.binding = parse_session_binding_info(require_json_object(envelope.data, "binding"));
  response.quota = parse_session_quota_info(require_json_object(envelope.data, "quota"));

  if (envelope.data.has("account") && envelope.data.at("account").is_object()) {
    const JsonValue& account = envelope.data.at("account");
    response.account_id = require_json_string(account, "id");
    response.account_username = require_json_string(account, "username");
  }

  if (envelope.data.has("card") && envelope.data.at("card").is_object()) {
    const JsonValue& card = envelope.data.at("card");
    if (card.has("maskedKey") && card.at("maskedKey").is_string()) {
      response.card_masked_key = card.at("maskedKey").as_string();
    }
  }

  return response;
}

HeartbeatResponse LicenseClientWin::parse_heartbeat_response(const ApiEnvelope& envelope) {
  if (!envelope.ok) {
    throw_api_exception(envelope, "Heartbeat request failed.");
  }

  HeartbeatResponse response;
  response.status = require_json_string(envelope.data, "status");
  response.account = require_json_string(envelope.data, "account");
  response.expires_at = require_json_string(envelope.data, "expiresAt");
  response.next_heartbeat_in_seconds = require_json_int(envelope.data, "nextHeartbeatInSeconds");
  return response;
}

LogoutResponse LicenseClientWin::parse_logout_response(const ApiEnvelope& envelope) {
  if (!envelope.ok) {
    throw_api_exception(envelope, "Logout request failed.");
  }

  LogoutResponse response;
  response.status = require_json_string(envelope.data, "status");
  return response;
}

LicenseClientWin::LicenseClientWin(
  ClientIdentity identity,
  HttpEndpoint http_endpoint,
  TcpEndpoint tcp_endpoint
)
    : identity_(identity), http_(http_endpoint), tcp_(tcp_endpoint) {}

std::string LicenseClientWin::generate_device_fingerprint() const {
  return rocksolid::generate_device_fingerprint(identity_.app_salt);
}

TransportResult LicenseClientWin::register_http(const RegisterRequest& request) const {
  return http_.post_json(make_signed_http_request("/api/client/register", to_json(request)));
}

TransportResult LicenseClientWin::recharge_http(const RechargeRequest& request) const {
  return http_.post_json(make_signed_http_request("/api/client/recharge", to_json(request)));
}

TransportResult LicenseClientWin::bindings_http(const BindingsRequest& request) const {
  return http_.post_json(make_signed_http_request("/api/client/bindings", to_json(request)));
}

TransportResult LicenseClientWin::unbind_http(const UnbindRequest& request) const {
  return http_.post_json(make_signed_http_request("/api/client/unbind", to_json(request)));
}

TransportResult LicenseClientWin::version_check_http(const ClientVersionCheckRequest& request) const {
  return http_.post_json(make_signed_http_request("/api/client/version-check", to_json(request)));
}

TransportResult LicenseClientWin::notices_http(const ClientNoticesRequest& request) const {
  return http_.post_json(make_signed_http_request("/api/client/notices", to_json(request)));
}

TransportResult LicenseClientWin::card_login_http(const CardLoginRequest& request) const {
  return http_.post_json(make_signed_http_request("/api/client/card-login", to_json(request)));
}

TransportResult LicenseClientWin::login_http(const LoginRequest& request) const {
  return http_.post_json(make_signed_http_request("/api/client/login", to_json(request)));
}

TransportResult LicenseClientWin::heartbeat_http(const HeartbeatRequest& request) const {
  return http_.post_json(make_signed_http_request("/api/client/heartbeat", to_json(request)));
}

TransportResult LicenseClientWin::logout_http(const LogoutRequest& request) const {
  return http_.post_json(make_signed_http_request("/api/client/logout", to_json(request)));
}

TransportResult LicenseClientWin::register_tcp(const RegisterRequest& request) const {
  return tcp_.call(make_signed_tcp_frame("client.register", "/api/client/register", to_json(request)));
}

TransportResult LicenseClientWin::recharge_tcp(const RechargeRequest& request) const {
  return tcp_.call(make_signed_tcp_frame("client.recharge", "/api/client/recharge", to_json(request)));
}

TransportResult LicenseClientWin::bindings_tcp(const BindingsRequest& request) const {
  return tcp_.call(make_signed_tcp_frame("client.bindings", "/api/client/bindings", to_json(request)));
}

TransportResult LicenseClientWin::unbind_tcp(const UnbindRequest& request) const {
  return tcp_.call(make_signed_tcp_frame("client.unbind", "/api/client/unbind", to_json(request)));
}

TransportResult LicenseClientWin::card_login_tcp(const CardLoginRequest& request) const {
  return tcp_.call(make_signed_tcp_frame("client.card-login", "/api/client/card-login", to_json(request)));
}

TransportResult LicenseClientWin::login_tcp(const LoginRequest& request) const {
  return tcp_.call(make_signed_tcp_frame("client.login", "/api/client/login", to_json(request)));
}

TransportResult LicenseClientWin::heartbeat_tcp(const HeartbeatRequest& request) const {
  return tcp_.call(make_signed_tcp_frame("client.heartbeat", "/api/client/heartbeat", to_json(request)));
}

TransportResult LicenseClientWin::logout_tcp(const LogoutRequest& request) const {
  return tcp_.call(make_signed_tcp_frame("client.logout", "/api/client/logout", to_json(request)));
}

RegisterResponse LicenseClientWin::register_http_parsed(const RegisterRequest& request) const {
  return parse_register_response(parse_api_envelope(register_http(request)));
}

RechargeResponse LicenseClientWin::recharge_http_parsed(const RechargeRequest& request) const {
  return parse_recharge_response(parse_api_envelope(recharge_http(request)));
}

BindingsResponse LicenseClientWin::bindings_http_parsed(const BindingsRequest& request) const {
  return parse_bindings_response(parse_api_envelope(bindings_http(request)));
}

UnbindResponse LicenseClientWin::unbind_http_parsed(const UnbindRequest& request) const {
  return parse_unbind_response(parse_api_envelope(unbind_http(request)));
}

ClientVersionManifestResponse LicenseClientWin::version_check_http_parsed(
  const ClientVersionCheckRequest& request
) const {
  return parse_version_check_response(parse_api_envelope(version_check_http(request)));
}

ClientNoticesResponse LicenseClientWin::notices_http_parsed(const ClientNoticesRequest& request) const {
  return parse_notices_response(parse_api_envelope(notices_http(request)));
}

ClientStartupBootstrapResponse LicenseClientWin::startup_bootstrap_http(
  const ClientStartupBootstrapRequest& request
) const {
  try {
    return parse_startup_bootstrap_response(parse_api_envelope(
      http_.post_json(make_signed_http_request("/api/client/startup-bootstrap", to_json(request)))
    ));
  } catch (const ApiException& error) {
    if (error.status() != 404 && error.code() != "NOT_FOUND") {
      throw;
    }
  }

  ClientStartupBootstrapResponse response;
  response.version_manifest = version_check_http_parsed(ClientVersionCheckRequest{
    request.product_code,
    request.client_version,
    request.channel
  });
  response.notices = notices_http_parsed(ClientNoticesRequest{
    request.product_code,
    request.channel
  });

  if (request.include_token_keys) {
    response.token_keys = fetch_token_keys();
    response.active_token_key = select_active_token_key(response.token_keys);
    response.has_token_keys = true;
  } else {
    response.active_token_key = fetch_active_token_key();
    response.has_token_keys = false;
  }

  return response;
}

LoginResponse LicenseClientWin::card_login_http_parsed(const CardLoginRequest& request) const {
  return parse_login_response(parse_api_envelope(card_login_http(request)));
}

LoginResponse LicenseClientWin::login_http_parsed(const LoginRequest& request) const {
  return parse_login_response(parse_api_envelope(login_http(request)));
}

HeartbeatResponse LicenseClientWin::heartbeat_http_parsed(const HeartbeatRequest& request) const {
  return parse_heartbeat_response(parse_api_envelope(heartbeat_http(request)));
}

LogoutResponse LicenseClientWin::logout_http_parsed(const LogoutRequest& request) const {
  return parse_logout_response(parse_api_envelope(logout_http(request)));
}

RegisterResponse LicenseClientWin::register_tcp_parsed(const RegisterRequest& request) const {
  return parse_register_response(parse_api_envelope(register_tcp(request)));
}

RechargeResponse LicenseClientWin::recharge_tcp_parsed(const RechargeRequest& request) const {
  return parse_recharge_response(parse_api_envelope(recharge_tcp(request)));
}

BindingsResponse LicenseClientWin::bindings_tcp_parsed(const BindingsRequest& request) const {
  return parse_bindings_response(parse_api_envelope(bindings_tcp(request)));
}

UnbindResponse LicenseClientWin::unbind_tcp_parsed(const UnbindRequest& request) const {
  return parse_unbind_response(parse_api_envelope(unbind_tcp(request)));
}

LoginResponse LicenseClientWin::card_login_tcp_parsed(const CardLoginRequest& request) const {
  return parse_login_response(parse_api_envelope(card_login_tcp(request)));
}

LoginResponse LicenseClientWin::login_tcp_parsed(const LoginRequest& request) const {
  return parse_login_response(parse_api_envelope(login_tcp(request)));
}

HeartbeatResponse LicenseClientWin::heartbeat_tcp_parsed(const HeartbeatRequest& request) const {
  return parse_heartbeat_response(parse_api_envelope(heartbeat_tcp(request)));
}

LogoutResponse LicenseClientWin::logout_tcp_parsed(const LogoutRequest& request) const {
  return parse_logout_response(parse_api_envelope(logout_tcp(request)));
}

TokenKeyInfo LicenseClientWin::fetch_active_token_key() const {
  return select_active_token_key(parse_token_key_set(parse_api_envelope(http_.get_json("/api/system/token-key"))));
}

TokenKeySet LicenseClientWin::fetch_token_keys() const {
  return parse_token_key_set(parse_api_envelope(http_.get_json("/api/system/token-keys")));
}

TokenValidationResult LicenseClientWin::validate_license_token_online(const std::string& token) const {
  return validate_license_token_with_key_set(token, fetch_token_keys());
}

TokenValidationResult LicenseClientWin::validate_license_token_with_key_set(
  const std::string& token,
  const TokenKeySet& key_set
) {
  TokenValidationResult result = prepare_token_validation_result(token);
  for (const TokenKeyInfo& key : key_set.keys) {
    if (key.key_id == result.key_id) {
      result.valid = verify_license_token(key.public_key_pem, token);
      return result;
    }
  }

  result.valid = false;
  return result;
}

TokenValidationResult LicenseClientWin::validate_license_token_with_key(
  const std::string& token,
  const TokenKeyInfo& key
) {
  TokenValidationResult result = prepare_token_validation_result(token);
  if (!result.key_id.empty() && !key.key_id.empty() && result.key_id != key.key_id) {
    result.valid = false;
    return result;
  }

  result.valid = verify_license_token(key.public_key_pem, token);
  return result;
}

TokenValidationResult LicenseClientWin::validate_license_token_with_bootstrap(
  const std::string& token,
  const ClientStartupBootstrapResponse& bootstrap
) {
  if (bootstrap.has_token_keys && !bootstrap.token_keys.keys.empty()) {
    return validate_license_token_with_key_set(token, bootstrap.token_keys);
  }
  return validate_license_token_with_key(token, bootstrap.active_token_key);
}

ClientStartupDecision LicenseClientWin::evaluate_startup_decision(
  const ClientStartupBootstrapResponse& bootstrap
) {
  ClientStartupDecision decision;
  decision.latest_version = bootstrap.version_manifest.latest_version;
  decision.minimum_allowed_version = bootstrap.version_manifest.minimum_allowed_version;
  decision.latest_download_url = bootstrap.version_manifest.latest_download_url;
  decision.force_update_required = bootstrap.version_manifest.status == "force_update_required";
  decision.disabled_version = bootstrap.version_manifest.status == "disabled_version";
  decision.upgrade_recommended = bootstrap.version_manifest.status == "upgrade_recommended";
  decision.version_blocked = !bootstrap.version_manifest.allowed;

  for (const NoticeInfo& notice : bootstrap.notices.notices) {
    if (notice.block_login) {
      decision.blocking_notices.push_back(notice);
    } else {
      decision.announcements.push_back(notice);
    }
  }

  decision.maintenance_blocking = !decision.blocking_notices.empty();
  decision.has_announcements = !decision.announcements.empty();
  decision.allow_login = !decision.maintenance_blocking && !decision.version_blocked;

  if (decision.maintenance_blocking) {
    const NoticeInfo& notice = decision.blocking_notices.front();
    decision.primary_code = "notice_blocked";
    decision.primary_title = notice.title;
    decision.primary_message = notice.body;
    return decision;
  }

  if (decision.version_blocked) {
    decision.primary_code = bootstrap.version_manifest.status.empty()
      ? "version_blocked"
      : bootstrap.version_manifest.status;
    decision.primary_title = bootstrap.version_manifest.notice.present &&
        !bootstrap.version_manifest.notice.title.empty()
      ? bootstrap.version_manifest.notice.title
      : "Client update required";
    decision.primary_message = bootstrap.version_manifest.message;
    return decision;
  }

  if (decision.upgrade_recommended) {
    decision.primary_code = "upgrade_recommended";
    decision.primary_title = bootstrap.version_manifest.notice.present &&
        !bootstrap.version_manifest.notice.title.empty()
      ? bootstrap.version_manifest.notice.title
      : "Upgrade recommended";
    decision.primary_message = bootstrap.version_manifest.message;
    return decision;
  }

  if (decision.has_announcements) {
    const NoticeInfo& notice = decision.announcements.front();
    decision.primary_code = "announcement";
    decision.primary_title = notice.title;
    decision.primary_message = notice.body;
    return decision;
  }

  decision.primary_code = "allowed";
  decision.primary_title = "Ready";
  decision.primary_message = bootstrap.version_manifest.message;
  return decision;
}

std::string LicenseClientWin::serialize_startup_bootstrap(
  const ClientStartupBootstrapResponse& bootstrap
) {
  return serialize_client_startup_bootstrap_json(bootstrap);
}

ClientStartupBootstrapResponse LicenseClientWin::parse_startup_bootstrap(
  const std::string& json_text
) {
  const JsonValue root = JsonValue::parse(json_text);
  if (!root.is_object()) {
    throw std::runtime_error("Startup bootstrap cache root must be a JSON object.");
  }

  ClientStartupBootstrapResponse bootstrap;
  bootstrap.version_manifest = parse_client_version_manifest_object(
    require_object_field(root, "versionManifest", JsonType::object)
  );
  bootstrap.notices = parse_client_notices_object(
    require_object_field(root, "notices", JsonType::object)
  );
  bootstrap.active_token_key = parse_token_key_info_payload(
    require_object_field(root, "activeTokenKey", JsonType::object),
    ""
  );
  if (const JsonValue* token_keys = optional_object_value(root, "tokenKeys")) {
    bootstrap.token_keys = parse_token_key_set_object(*token_keys);
  }
  bootstrap.has_token_keys = optional_object_bool(root, "hasTokenKeys", false);
  return bootstrap;
}

std::string LicenseClientWin::serialize_startup_bootstrap_cache(
  const ClientStartupBootstrapCache& cache
) {
  std::ostringstream stream;
  stream
    << "{"
    << "\"schemaVersion\":" << json_int_literal(cache.schema_version) << ","
    << "\"cachedAt\":" << json_string_or_null(cache.cached_at) << ","
    << "\"bootstrap\":" << serialize_startup_bootstrap(cache.bootstrap)
    << "}";
  return stream.str();
}

ClientStartupBootstrapCache LicenseClientWin::parse_startup_bootstrap_cache(
  const std::string& json_text
) {
  const JsonValue root = JsonValue::parse(json_text);
  if (!root.is_object()) {
    throw std::runtime_error("Startup bootstrap cache root must be a JSON object.");
  }

  ClientStartupBootstrapCache cache;
  cache.schema_version = optional_object_int(root, "schemaVersion", 1);
  cache.cached_at = optional_object_string(root, "cachedAt");
  const JsonValue& bootstrap = require_object_field(root, "bootstrap", JsonType::object);
  cache.bootstrap.version_manifest = parse_client_version_manifest_object(
    require_object_field(bootstrap, "versionManifest", JsonType::object)
  );
  cache.bootstrap.notices = parse_client_notices_object(
    require_object_field(bootstrap, "notices", JsonType::object)
  );
  cache.bootstrap.active_token_key = parse_token_key_info_payload(
    require_object_field(bootstrap, "activeTokenKey", JsonType::object),
    ""
  );
  if (const JsonValue* token_keys = optional_object_value(bootstrap, "tokenKeys")) {
    cache.bootstrap.token_keys = parse_token_key_set_object(*token_keys);
  }
  cache.bootstrap.has_token_keys = optional_object_bool(bootstrap, "hasTokenKeys", false);
  return cache;
}

void LicenseClientWin::write_startup_bootstrap_cache_file(
  const std::string& path,
  const ClientStartupBootstrapCache& cache
) {
  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  if (!output) {
    throw std::runtime_error("Unable to open startup bootstrap cache file for writing.");
  }

  const std::string json_text = serialize_startup_bootstrap_cache(cache);
  output.write(json_text.data(), static_cast<std::streamsize>(json_text.size()));
  if (!output.good()) {
    throw std::runtime_error("Unable to write startup bootstrap cache file.");
  }
}

ClientStartupBootstrapCache LicenseClientWin::read_startup_bootstrap_cache_file(
  const std::string& path
) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    throw std::runtime_error("Unable to open startup bootstrap cache file for reading.");
  }

  std::ostringstream buffer;
  buffer << input.rdbuf();
  if (!input.good() && !input.eof()) {
    throw std::runtime_error("Unable to read startup bootstrap cache file.");
  }

  return parse_startup_bootstrap_cache(buffer.str());
}

SignedRequest LicenseClientWin::make_signed_http_request(
  const std::string& path,
  const std::string& body
) const {
  return build_signed_request(identity_.app_id, identity_.app_secret, "POST", path, body);
}

TcpFrame LicenseClientWin::make_signed_tcp_frame(
  const std::string& action,
  const std::string& path,
  const std::string& body
) const {
  return build_tcp_frame(generate_nonce(), action, make_signed_http_request(path, body));
}

std::string LicenseClientWin::to_json(const RegisterRequest& request) {
  std::ostringstream stream;
  stream
    << "{"
    << build_json_pair("productCode", require_not_empty("productCode", request.product_code)) << ","
    << build_json_pair("username", require_not_empty("username", request.username)) << ","
    << build_json_pair("password", require_not_empty("password", request.password))
    << "}";
  return stream.str();
}

std::string LicenseClientWin::to_json(const RechargeRequest& request) {
  std::ostringstream stream;
  stream
    << "{"
    << build_json_pair("productCode", require_not_empty("productCode", request.product_code)) << ","
    << build_json_pair("username", require_not_empty("username", request.username)) << ","
    << build_json_pair("password", require_not_empty("password", request.password)) << ","
    << build_json_pair("cardKey", require_not_empty("cardKey", request.card_key))
    << "}";
  return stream.str();
}

std::string LicenseClientWin::to_json(const BindingsRequest& request) {
  std::ostringstream stream;
  stream
    << "{"
    << build_json_pair("productCode", require_not_empty("productCode", request.product_code));

  if (!request.card_key.empty()) {
    stream << "," << build_json_pair("cardKey", request.card_key);
  } else {
    stream
      << "," << build_json_pair("username", require_not_empty("username", request.username))
      << "," << build_json_pair("password", require_not_empty("password", request.password));
  }

  stream << "}";
  return stream.str();
}

std::string LicenseClientWin::to_json(const UnbindRequest& request) {
  if (request.binding_id.empty() && request.device_fingerprint.empty()) {
    throw std::invalid_argument("unbind request requires binding_id or device_fingerprint");
  }

  std::ostringstream stream;
  stream
    << "{"
    << build_json_pair("productCode", require_not_empty("productCode", request.product_code));

  if (!request.card_key.empty()) {
    stream << "," << build_json_pair("cardKey", request.card_key);
  } else {
    stream
      << "," << build_json_pair("username", require_not_empty("username", request.username))
      << "," << build_json_pair("password", require_not_empty("password", request.password));
  }

  if (!request.binding_id.empty()) {
    stream << "," << build_json_pair("bindingId", request.binding_id);
  }
  if (!request.device_fingerprint.empty()) {
    stream << "," << build_json_pair("deviceFingerprint", request.device_fingerprint);
  }
  if (!request.reason.empty()) {
    stream << "," << build_json_pair("reason", request.reason);
  }

  stream << "}";
  return stream.str();
}

std::string LicenseClientWin::to_json(const ClientVersionCheckRequest& request) {
  std::ostringstream stream;
  stream
    << "{"
    << build_json_pair("productCode", require_not_empty("productCode", request.product_code)) << ","
    << build_json_pair("clientVersion", require_not_empty("clientVersion", request.client_version));
  if (!request.channel.empty()) {
    stream << "," << build_json_pair("channel", request.channel);
  }
  stream << "}";
  return stream.str();
}

std::string LicenseClientWin::to_json(const ClientNoticesRequest& request) {
  std::ostringstream stream;
  stream
    << "{"
    << build_json_pair("productCode", require_not_empty("productCode", request.product_code));
  if (!request.channel.empty()) {
    stream << "," << build_json_pair("channel", request.channel);
  }
  stream << "}";
  return stream.str();
}

std::string LicenseClientWin::to_json(const ClientStartupBootstrapRequest& request) {
  std::ostringstream stream;
  stream
    << "{"
    << build_json_pair("productCode", require_not_empty("productCode", request.product_code)) << ","
    << build_json_pair("clientVersion", require_not_empty("clientVersion", request.client_version));
  if (!request.channel.empty()) {
    stream << "," << build_json_pair("channel", request.channel);
  }
  stream << ",\"includeTokenKeys\":" << json_bool_literal(request.include_token_keys);
  stream << "}";
  return stream.str();
}

std::string LicenseClientWin::to_json(const CardLoginRequest& request) {
  const std::string device_profile_json = build_device_profile_json(request.device_profile);
  std::ostringstream stream;
  stream
    << "{"
    << build_json_pair("productCode", require_not_empty("productCode", request.product_code)) << ","
    << build_json_pair("cardKey", require_not_empty("cardKey", request.card_key)) << ","
    << build_json_pair("deviceFingerprint", require_not_empty("deviceFingerprint", request.device_fingerprint)) << ","
    << build_json_pair("deviceName", require_not_empty("deviceName", request.device_name));
  if (!request.client_version.empty()) {
    stream << "," << build_json_pair("clientVersion", request.client_version);
  }
  if (!request.channel.empty()) {
    stream << "," << build_json_pair("channel", request.channel);
  }
  if (!device_profile_json.empty()) {
    stream << ",\"deviceProfile\":" << device_profile_json;
  }
  stream << "}";
  return stream.str();
}

std::string LicenseClientWin::to_json(const LoginRequest& request) {
  const std::string device_profile_json = build_device_profile_json(request.device_profile);
  std::ostringstream stream;
  stream
    << "{"
    << build_json_pair("productCode", require_not_empty("productCode", request.product_code)) << ","
    << build_json_pair("username", require_not_empty("username", request.username)) << ","
    << build_json_pair("password", require_not_empty("password", request.password)) << ","
    << build_json_pair("deviceFingerprint", require_not_empty("deviceFingerprint", request.device_fingerprint)) << ","
    << build_json_pair("deviceName", require_not_empty("deviceName", request.device_name));
  if (!request.client_version.empty()) {
    stream << "," << build_json_pair("clientVersion", request.client_version);
  }
  if (!request.channel.empty()) {
    stream << "," << build_json_pair("channel", request.channel);
  }
  if (!device_profile_json.empty()) {
    stream << ",\"deviceProfile\":" << device_profile_json;
  }
  stream << "}";
  return stream.str();
}

std::string LicenseClientWin::to_json(const HeartbeatRequest& request) {
  std::ostringstream stream;
  stream
    << "{"
    << build_json_pair("productCode", require_not_empty("productCode", request.product_code)) << ","
    << build_json_pair("sessionToken", require_not_empty("sessionToken", request.session_token)) << ","
    << build_json_pair("deviceFingerprint", require_not_empty("deviceFingerprint", request.device_fingerprint));
  if (!request.client_version.empty()) {
    stream << "," << build_json_pair("clientVersion", request.client_version);
  }
  if (!request.channel.empty()) {
    stream << "," << build_json_pair("channel", request.channel);
  }
  stream << "}";
  return stream.str();
}

std::string LicenseClientWin::to_json(const LogoutRequest& request) {
  std::ostringstream stream;
  stream
    << "{"
    << build_json_pair("productCode", require_not_empty("productCode", request.product_code)) << ","
    << build_json_pair("sessionToken", require_not_empty("sessionToken", request.session_token))
    << "}";
  return stream.str();
}

std::string LicenseClientWin::require_not_empty(const char* field_name, const std::string& value) {
  if (value.empty()) {
    throw std::invalid_argument(std::string(field_name) + " must not be empty");
  }
  return value;
}

}  // namespace rocksolid

#endif
