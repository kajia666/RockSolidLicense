#ifdef _WIN32

#include "../include/rocksolid_sdk.h"

#include <windows.h>
#include <bcrypt.h>
#include <wincrypt.h>

#include <cstring>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "crypt32.lib")

namespace {

constexpr size_t kDigestHexWithNull = RS_SHA256_HEX_LEN + 1;
constexpr size_t kNonceHexWithNull = RS_NONCE_HEX_LEN + 1;

struct LocalFreeDeleter {
  void operator()(void* value) const {
    if (value != nullptr) {
      LocalFree(value);
    }
  }
};

bool write_hex(const std::vector<unsigned char>& bytes, char* out_hex, size_t out_len) {
  static const char hex[] = "0123456789abcdef";
  const size_t needed = bytes.size() * 2 + 1;
  if (!out_hex || out_len < needed) {
    return false;
  }

  for (size_t index = 0; index < bytes.size(); ++index) {
    out_hex[index * 2] = hex[(bytes[index] >> 4) & 0x0F];
    out_hex[index * 2 + 1] = hex[bytes[index] & 0x0F];
  }
  out_hex[needed - 1] = '\0';
  return true;
}

bool sha256_bytes(const unsigned char* data, size_t len, std::vector<unsigned char>& digest) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_size = 0;
  DWORD result_size = 0;
  DWORD digest_size = 0;

  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) {
    return false;
  }

  if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size), &result_size, 0) != 0) {
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }

  if (BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&digest_size), sizeof(digest_size), &result_size, 0) != 0) {
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }

  std::vector<unsigned char> object_buffer(object_size);
  digest.assign(digest_size, 0);

  if (BCryptCreateHash(algorithm, &hash, object_buffer.data(), static_cast<ULONG>(object_buffer.size()), nullptr, 0, 0) != 0) {
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }

  const auto status_hash = BCryptHashData(hash, const_cast<PUCHAR>(data), static_cast<ULONG>(len), 0);
  const auto status_finish = BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0);

  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return status_hash == 0 && status_finish == 0;
}

bool hmac_sha256_bytes(const std::string& secret, const std::string& message, std::vector<unsigned char>& digest) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_size = 0;
  DWORD result_size = 0;
  DWORD digest_size = 0;

  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, BCRYPT_ALG_HANDLE_HMAC_FLAG) != 0) {
    return false;
  }

  if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size), &result_size, 0) != 0) {
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }

  if (BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&digest_size), sizeof(digest_size), &result_size, 0) != 0) {
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }

  std::vector<unsigned char> object_buffer(object_size);
  digest.assign(digest_size, 0);

  if (BCryptCreateHash(
        algorithm,
        &hash,
        object_buffer.data(),
        static_cast<ULONG>(object_buffer.size()),
        reinterpret_cast<PUCHAR>(const_cast<char*>(secret.data())),
        static_cast<ULONG>(secret.size()),
        0) != 0) {
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }

  const auto status_hash = BCryptHashData(
    hash,
    reinterpret_cast<PUCHAR>(const_cast<char*>(message.data())),
    static_cast<ULONG>(message.size()),
    0);
  const auto status_finish = BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0);

  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return status_hash == 0 && status_finish == 0;
}

bool base64url_to_bytes(const std::string& input, std::vector<unsigned char>& output) {
  std::string base64 = input;
  for (char& ch : base64) {
    if (ch == '-') {
      ch = '+';
    } else if (ch == '_') {
      ch = '/';
    }
  }

  while (base64.size() % 4 != 0) {
    base64.push_back('=');
  }

  DWORD required = 0;
  if (!CryptStringToBinaryA(
        base64.c_str(),
        0,
        CRYPT_STRING_BASE64,
        nullptr,
        &required,
        nullptr,
        nullptr
      )) {
    return false;
  }

  output.assign(required, 0);
  return CryptStringToBinaryA(
    base64.c_str(),
    0,
    CRYPT_STRING_BASE64,
    output.data(),
    &required,
    nullptr,
    nullptr
  ) == TRUE;
}

bool base64url_to_string(const std::string& input, std::string& output) {
  std::vector<unsigned char> bytes;
  if (!base64url_to_bytes(input, bytes)) {
    return false;
  }

  output.assign(reinterpret_cast<const char*>(bytes.data()), bytes.size());
  return true;
}

bool split_token(
  const char* token,
  std::string& encoded_header,
  std::string& encoded_payload,
  std::string& encoded_signature
) {
  if (!token) {
    return false;
  }

  const std::string raw(token);
  const size_t first = raw.find('.');
  if (first == std::string::npos) {
    return false;
  }

  const size_t second = raw.find('.', first + 1);
  if (second == std::string::npos) {
    return false;
  }

  encoded_header = raw.substr(0, first);
  encoded_payload = raw.substr(first + 1, second - first - 1);
  encoded_signature = raw.substr(second + 1);
  return !encoded_header.empty() && !encoded_payload.empty() && !encoded_signature.empty();
}

bool contains_rs256_alg(const std::string& decoded_header) {
  return decoded_header.find("\"alg\":\"RS256\"") != std::string::npos;
}

bool import_public_key_pem(const char* public_key_pem, BCRYPT_KEY_HANDLE& key_handle) {
  key_handle = nullptr;
  if (!public_key_pem) {
    return false;
  }

  DWORD der_length = 0;
  if (!CryptStringToBinaryA(
        public_key_pem,
        0,
        CRYPT_STRING_BASE64HEADER,
        nullptr,
        &der_length,
        nullptr,
        nullptr
      )) {
    return false;
  }

  std::vector<unsigned char> der(der_length, 0);
  if (!CryptStringToBinaryA(
        public_key_pem,
        0,
        CRYPT_STRING_BASE64HEADER,
        der.data(),
        &der_length,
        nullptr,
        nullptr
      )) {
    return false;
  }

  CERT_PUBLIC_KEY_INFO* public_key_info = nullptr;
  DWORD public_key_info_length = 0;
  if (!CryptDecodeObjectEx(
        X509_ASN_ENCODING,
        X509_PUBLIC_KEY_INFO,
        der.data(),
        der_length,
        CRYPT_DECODE_ALLOC_FLAG,
        nullptr,
        &public_key_info,
        &public_key_info_length
      )) {
    return false;
  }

  std::unique_ptr<void, LocalFreeDeleter> public_key_info_owner(public_key_info);
  return CryptImportPublicKeyInfoEx2(
           X509_ASN_ENCODING,
           public_key_info,
           0,
           nullptr,
           &key_handle
         ) == TRUE;
}

std::string body_hash_hex(const char* body) {
  const unsigned char* buffer = reinterpret_cast<const unsigned char*>(body ? body : "");
  const size_t length = body ? strlen(body) : 0;
  std::vector<unsigned char> digest;
  if (!sha256_bytes(buffer, length, digest)) {
    return "";
  }

  std::string hex(digest.size() * 2, '\0');
  static const char table[] = "0123456789abcdef";
  for (size_t index = 0; index < digest.size(); ++index) {
    hex[index * 2] = table[(digest[index] >> 4) & 0x0F];
    hex[index * 2 + 1] = table[digest[index] & 0x0F];
  }
  return hex;
}

std::string make_device_source(const char* app_salt) {
  char computer_name[MAX_COMPUTERNAME_LENGTH + 1] = {0};
  DWORD computer_name_len = MAX_COMPUTERNAME_LENGTH + 1;
  GetComputerNameA(computer_name, &computer_name_len);

  DWORD volume_serial = 0;
  GetVolumeInformationA("C:\\", nullptr, 0, &volume_serial, nullptr, nullptr, nullptr, 0);

  SYSTEM_INFO system_info{};
  GetNativeSystemInfo(&system_info);

  std::ostringstream stream;
  stream
    << "salt=" << (app_salt ? app_salt : "")
    << ";computer=" << computer_name
    << ";volume=" << volume_serial
    << ";arch=" << system_info.wProcessorArchitecture
    << ";processors=" << system_info.dwNumberOfProcessors;

  return stream.str();
}

}  // namespace

extern "C" {

int rs_generate_nonce(char* out_hex, size_t out_len) {
  if (!out_hex || out_len < kNonceHexWithNull) {
    return RS_ERROR_BUFFER_TOO_SMALL;
  }

  std::vector<unsigned char> bytes(RS_NONCE_HEX_LEN / 2, 0);
  if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    return RS_ERROR_CRYPTO;
  }

  return write_hex(bytes, out_hex, out_len) ? RS_OK : RS_ERROR_BUFFER_TOO_SMALL;
}

int rs_sha256_hex(const unsigned char* data, size_t len, char* out_hex, size_t out_len) {
  if (!data || !out_hex) {
    return RS_ERROR_INVALID_ARG;
  }

  std::vector<unsigned char> digest;
  if (!sha256_bytes(data, len, digest)) {
    return RS_ERROR_CRYPTO;
  }

  return write_hex(digest, out_hex, out_len) ? RS_OK : RS_ERROR_BUFFER_TOO_SMALL;
}

int rs_hmac_sha256_hex(const char* secret, const char* message, char* out_hex, size_t out_len) {
  if (!secret || !message || !out_hex) {
    return RS_ERROR_INVALID_ARG;
  }

  std::vector<unsigned char> digest;
  if (!hmac_sha256_bytes(secret, message, digest)) {
    return RS_ERROR_CRYPTO;
  }

  return write_hex(digest, out_hex, out_len) ? RS_OK : RS_ERROR_BUFFER_TOO_SMALL;
}

int rs_generate_device_fingerprint(const char* app_salt, char* out_hex, size_t out_len) {
  if (!out_hex || out_len < kDigestHexWithNull) {
    return RS_ERROR_BUFFER_TOO_SMALL;
  }

  const std::string source = make_device_source(app_salt);
  return rs_sha256_hex(
    reinterpret_cast<const unsigned char*>(source.data()),
    source.size(),
    out_hex,
    out_len
  );
}

int rs_sign_request(
  const char* secret,
  const char* method,
  const char* path,
  const char* timestamp,
  const char* nonce,
  const char* body,
  char* out_signature_hex,
  size_t out_len
) {
  if (!secret || !method || !path || !timestamp || !nonce || !out_signature_hex) {
    return RS_ERROR_INVALID_ARG;
  }

  const std::string body_hash = body_hash_hex(body);
  if (body_hash.empty()) {
    return RS_ERROR_CRYPTO;
  }

  std::ostringstream stream;
  stream
    << method << "\n"
    << path << "\n"
    << timestamp << "\n"
    << nonce << "\n"
    << body_hash;

  return rs_hmac_sha256_hex(secret, stream.str().c_str(), out_signature_hex, out_len);
}

int rs_decode_license_token_payload(const char* token, char* out_json, size_t out_len) {
  if (!token || !out_json) {
    return RS_ERROR_INVALID_ARG;
  }

  std::string encoded_header;
  std::string encoded_payload;
  std::string encoded_signature;
  if (!split_token(token, encoded_header, encoded_payload, encoded_signature)) {
    return RS_ERROR_INVALID_ARG;
  }

  std::string decoded_payload;
  if (!base64url_to_string(encoded_payload, decoded_payload)) {
    return RS_ERROR_CRYPTO;
  }

  if (out_len < decoded_payload.size() + 1) {
    return RS_ERROR_BUFFER_TOO_SMALL;
  }

  std::memcpy(out_json, decoded_payload.data(), decoded_payload.size());
  out_json[decoded_payload.size()] = '\0';
  return RS_OK;
}

int rs_verify_license_token(const char* public_key_pem, const char* token) {
  if (!public_key_pem || !token) {
    return RS_ERROR_INVALID_ARG;
  }

  std::string encoded_header;
  std::string encoded_payload;
  std::string encoded_signature;
  if (!split_token(token, encoded_header, encoded_payload, encoded_signature)) {
    return RS_ERROR_INVALID_ARG;
  }

  std::string decoded_header;
  if (!base64url_to_string(encoded_header, decoded_header)) {
    return RS_ERROR_CRYPTO;
  }

  if (!contains_rs256_alg(decoded_header)) {
    return RS_ERROR_CRYPTO;
  }

  std::vector<unsigned char> signature;
  if (!base64url_to_bytes(encoded_signature, signature)) {
    return RS_ERROR_CRYPTO;
  }

  const std::string signing_input = encoded_header + "." + encoded_payload;
  std::vector<unsigned char> digest;
  if (!sha256_bytes(
        reinterpret_cast<const unsigned char*>(signing_input.data()),
        signing_input.size(),
        digest
      )) {
    return RS_ERROR_CRYPTO;
  }

  BCRYPT_KEY_HANDLE key_handle = nullptr;
  if (!import_public_key_pem(public_key_pem, key_handle)) {
    return RS_ERROR_PLATFORM;
  }

  BCRYPT_PKCS1_PADDING_INFO padding_info{};
  padding_info.pszAlgId = BCRYPT_SHA256_ALGORITHM;
  const NTSTATUS status = BCryptVerifySignature(
    key_handle,
    &padding_info,
    digest.data(),
    static_cast<ULONG>(digest.size()),
    signature.data(),
    static_cast<ULONG>(signature.size()),
    BCRYPT_PAD_PKCS1
  );

  BCryptDestroyKey(key_handle);
  return status == 0 ? RS_OK : RS_ERROR_CRYPTO;
}

}  // extern "C"

#endif
