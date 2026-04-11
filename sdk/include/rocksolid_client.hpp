#ifndef ROCKSOLID_CLIENT_HPP
#define ROCKSOLID_CLIENT_HPP

#include "rocksolid_sdk.h"

#include <chrono>
#include <ctime>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>

namespace rocksolid {

inline std::string escape_json(const std::string& input);

struct SignedHeaders {
  std::string app_id;
  std::string timestamp;
  std::string nonce;
  std::string signature;
};

struct SignedRequest {
  std::string method;
  std::string path;
  std::string body;
  SignedHeaders headers;
};

struct TcpFrame {
  std::string id;
  std::string action;
  std::string body_text;
  SignedHeaders headers;

  std::string to_json_line() const {
    std::ostringstream stream;
    stream
      << "{"
      << "\"id\":\"" << escape_json(id) << "\","
      << "\"action\":\"" << escape_json(action) << "\","
      << "\"headers\":{"
      << "\"x-rs-app-id\":\"" << escape_json(headers.app_id) << "\","
      << "\"x-rs-timestamp\":\"" << escape_json(headers.timestamp) << "\","
      << "\"x-rs-nonce\":\"" << escape_json(headers.nonce) << "\","
      << "\"x-rs-signature\":\"" << escape_json(headers.signature) << "\""
      << "},"
      << "\"bodyText\":\"" << escape_json(body_text) << "\""
      << "}\n";
    return stream.str();
  }
};

inline std::string iso8601_now_utc() {
  using clock = std::chrono::system_clock;
  const auto now = clock::now();
  const auto time = clock::to_time_t(now);
  const auto milliseconds =
    std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()) % 1000;

  std::tm utc_time{};
#ifdef _WIN32
  gmtime_s(&utc_time, &time);
#else
  gmtime_r(&time, &utc_time);
#endif

  std::ostringstream stream;
  stream
    << std::put_time(&utc_time, "%Y-%m-%dT%H:%M:%S")
    << "."
    << std::setw(3) << std::setfill('0') << milliseconds.count()
    << "Z";
  return stream.str();
}

inline std::string generate_nonce() {
  char nonce[RS_NONCE_HEX_LEN + 1] = {0};
  const int status = rs_generate_nonce(nonce, sizeof(nonce));
  if (status != RS_OK) {
    throw std::runtime_error("rs_generate_nonce failed");
  }
  return nonce;
}

inline std::string generate_device_fingerprint(const std::string& app_salt) {
  char fingerprint[RS_FINGERPRINT_HEX_LEN + 1] = {0};
  const int status = rs_generate_device_fingerprint(
    app_salt.c_str(),
    fingerprint,
    sizeof(fingerprint)
  );
  if (status != RS_OK) {
    throw std::runtime_error("rs_generate_device_fingerprint failed");
  }
  return fingerprint;
}

inline std::string decode_license_token_payload(const std::string& token) {
  char payload[RS_LICENSE_TOKEN_MAX_LEN] = {0};
  const int status = rs_decode_license_token_payload(token.c_str(), payload, sizeof(payload));
  if (status != RS_OK) {
    throw std::runtime_error("rs_decode_license_token_payload failed");
  }
  return payload;
}

inline bool verify_license_token(const std::string& public_key_pem, const std::string& token) {
  return rs_verify_license_token(public_key_pem.c_str(), token.c_str()) == RS_OK;
}

inline std::string sign_request(
  const std::string& secret,
  const std::string& method,
  const std::string& path,
  const std::string& timestamp,
  const std::string& nonce,
  const std::string& body
) {
  char signature[RS_HMAC_SHA256_HEX_LEN + 1] = {0};
  const int status = rs_sign_request(
    secret.c_str(),
    method.c_str(),
    path.c_str(),
    timestamp.c_str(),
    nonce.c_str(),
    body.c_str(),
    signature,
    sizeof(signature)
  );
  if (status != RS_OK) {
    throw std::runtime_error("rs_sign_request failed");
  }
  return signature;
}

inline SignedRequest build_signed_request(
  const std::string& app_id,
  const std::string& secret,
  const std::string& method,
  const std::string& path,
  const std::string& body
) {
  const std::string timestamp = iso8601_now_utc();
  const std::string nonce = generate_nonce();
  const std::string signature = sign_request(secret, method, path, timestamp, nonce, body);

  return SignedRequest{
    method,
    path,
    body,
    SignedHeaders{app_id, timestamp, nonce, signature}
  };
}

inline TcpFrame build_tcp_frame(
  const std::string& request_id,
  const std::string& action,
  const SignedRequest& request
) {
  return TcpFrame{
    request_id,
    action,
    request.body,
    request.headers
  };
}

inline std::string escape_json(const std::string& input) {
  std::ostringstream stream;
  for (const char ch : input) {
    switch (ch) {
      case '\\':
        stream << "\\\\";
        break;
      case '"':
        stream << "\\\"";
        break;
      case '\b':
        stream << "\\b";
        break;
      case '\f':
        stream << "\\f";
        break;
      case '\n':
        stream << "\\n";
        break;
      case '\r':
        stream << "\\r";
        break;
      case '\t':
        stream << "\\t";
        break;
      default:
        if (static_cast<unsigned char>(ch) < 0x20) {
          stream
            << "\\u"
            << std::hex
            << std::uppercase
            << std::setw(4)
            << std::setfill('0')
            << static_cast<int>(static_cast<unsigned char>(ch))
            << std::dec
            << std::nouppercase;
        } else {
          stream << ch;
        }
        break;
    }
  }
  return stream.str();
}

}  // namespace rocksolid

#endif
