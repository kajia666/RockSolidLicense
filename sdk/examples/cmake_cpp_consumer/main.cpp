#include "rocksolid_client.hpp"

#include <iostream>

int main() {
  std::cout << "sdk_version=" << rocksolid::sdk_version_string() << std::endl;
  return 0;
}
