#include "rocksolid_sdk.h"

#include <stdio.h>

int main(void) {
  printf("sdk_version=%s\n", rs_sdk_version_string());
  return 0;
}
