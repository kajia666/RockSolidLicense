cmake_minimum_required(VERSION 3.20)

project(RockSolidSDKCapiConsumer LANGUAGES C)

find_package(RockSolidSDK CONFIG REQUIRED PATHS "${CMAKE_CURRENT_LIST_DIR}/../../cmake" NO_DEFAULT_PATH)

add_executable(cmake_capi_consumer main.c)
target_link_libraries(cmake_capi_consumer PRIVATE RockSolidSDK::capi)
