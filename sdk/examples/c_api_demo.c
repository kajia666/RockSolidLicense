#include "../include/rocksolid_sdk.h"

#include <stdio.h>
#include <string.h>

int main(void) {
  char nonce[RS_NONCE_HEX_LEN + 1] = {0};
  char fingerprint[RS_FINGERPRINT_HEX_LEN + 1] = {0};
  char signature[RS_HMAC_SHA256_HEX_LEN + 1] = {0};
  const char* body = "{\"productCode\":\"MY_SOFTWARE\"}";

  printf("sdk_version=%s\n", rs_sdk_version_string());

  if (rs_generate_nonce(nonce, sizeof(nonce)) != RS_OK) {
    fprintf(stderr, "rs_generate_nonce failed.\n");
    return 1;
  }

  if (rs_generate_device_fingerprint("my-product-salt", fingerprint, sizeof(fingerprint)) != RS_OK) {
    fprintf(stderr, "rs_generate_device_fingerprint failed.\n");
    return 1;
  }

  if (rs_sign_request(
        "sdk-secret",
        "POST",
        "/api/client/login",
        "2026-01-01T00:00:00.000Z",
        nonce,
        body,
        signature,
        sizeof(signature)
      ) != RS_OK) {
    fprintf(stderr, "rs_sign_request failed.\n");
    return 1;
  }

  printf("nonce=%s\n", nonce);
  printf("fingerprint=%s\n", fingerprint);
  printf("signature=%s\n", signature);

  return 0;
}
