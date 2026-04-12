#ifndef ROCKSOLID_SDK_H
#define ROCKSOLID_SDK_H

#include "rocksolid_sdk_version.h"

#include <stddef.h>

#if defined(_WIN32) && !defined(RS_SDK_STATIC)
#  if defined(RS_SDK_BUILD_DLL)
#    define RS_SDK_API __declspec(dllexport)
#  else
#    define RS_SDK_API __declspec(dllimport)
#  endif
#else
#  define RS_SDK_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define RS_SHA256_HEX_LEN 64
#define RS_HMAC_SHA256_HEX_LEN 64
#define RS_NONCE_HEX_LEN 32
#define RS_FINGERPRINT_HEX_LEN 64
#define RS_LICENSE_TOKEN_MAX_LEN 4096

typedef enum rs_status {
  RS_OK = 0,
  RS_ERROR_INVALID_ARG = -1,
  RS_ERROR_BUFFER_TOO_SMALL = -2,
  RS_ERROR_PLATFORM = -3,
  RS_ERROR_CRYPTO = -4
} rs_status;

RS_SDK_API int rs_generate_nonce(char* out_hex, size_t out_len);
RS_SDK_API int rs_sha256_hex(const unsigned char* data, size_t len, char* out_hex, size_t out_len);
RS_SDK_API int rs_hmac_sha256_hex(const char* secret, const char* message, char* out_hex, size_t out_len);
RS_SDK_API int rs_generate_device_fingerprint(const char* app_salt, char* out_hex, size_t out_len);
RS_SDK_API int rs_sign_request(
  const char* secret,
  const char* method,
  const char* path,
  const char* timestamp,
  const char* nonce,
  const char* body,
  char* out_signature_hex,
  size_t out_len
);
RS_SDK_API int rs_decode_license_token_payload(const char* token, char* out_json, size_t out_len);
RS_SDK_API int rs_verify_license_token(const char* public_key_pem, const char* token);
RS_SDK_API const char* rs_sdk_version_string(void);

#ifdef __cplusplus
}
#endif

#endif
