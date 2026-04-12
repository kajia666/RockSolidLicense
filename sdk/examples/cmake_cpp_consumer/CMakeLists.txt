cmake_minimum_required(VERSION 3.20)

project(RockSolidSDKCppConsumer LANGUAGES CXX)

find_package(RockSolidSDK CONFIG REQUIRED PATHS "${CMAKE_CURRENT_LIST_DIR}/../../cmake" NO_DEFAULT_PATH)

add_executable(cmake_cpp_consumer main.cpp)
target_compile_features(cmake_cpp_consumer PRIVATE cxx_std_17)
target_link_libraries(cmake_cpp_consumer PRIVATE RockSolidSDK::cpp_static)
