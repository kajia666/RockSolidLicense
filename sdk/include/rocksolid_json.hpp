#ifndef ROCKSOLID_JSON_HPP
#define ROCKSOLID_JSON_HPP

#include <cctype>
#include <cstddef>
#include <cstdlib>
#include <map>
#include <stdexcept>
#include <string>
#include <utility>
#include <variant>
#include <vector>

namespace rocksolid {

enum class JsonType {
  null_value,
  boolean,
  number,
  string,
  object,
  array
};

class JsonValue {
 public:
  using Object = std::map<std::string, JsonValue>;
  using Array = std::vector<JsonValue>;

  JsonValue() : value_(nullptr) {}
  JsonValue(std::nullptr_t) : value_(nullptr) {}
  JsonValue(bool value) : value_(value) {}
  JsonValue(double value) : value_(value) {}
  JsonValue(std::string value) : value_(std::move(value)) {}
  JsonValue(Object value) : value_(std::move(value)) {}
  JsonValue(Array value) : value_(std::move(value)) {}

  JsonType type() const {
    switch (value_.index()) {
      case 0:
        return JsonType::null_value;
      case 1:
        return JsonType::boolean;
      case 2:
        return JsonType::number;
      case 3:
        return JsonType::string;
      case 4:
        return JsonType::object;
      default:
        return JsonType::array;
    }
  }

  bool is_null() const { return std::holds_alternative<std::nullptr_t>(value_); }
  bool is_bool() const { return std::holds_alternative<bool>(value_); }
  bool is_number() const { return std::holds_alternative<double>(value_); }
  bool is_string() const { return std::holds_alternative<std::string>(value_); }
  bool is_object() const { return std::holds_alternative<Object>(value_); }
  bool is_array() const { return std::holds_alternative<Array>(value_); }

  bool as_bool() const { return std::get<bool>(value_); }
  double as_number() const { return std::get<double>(value_); }
  const std::string& as_string() const { return std::get<std::string>(value_); }
  const Object& as_object() const { return std::get<Object>(value_); }
  const Array& as_array() const { return std::get<Array>(value_); }

  bool has(const std::string& key) const {
    if (!is_object()) {
      return false;
    }
    return as_object().find(key) != as_object().end();
  }

  const JsonValue& at(const std::string& key) const {
    return as_object().at(key);
  }

  static JsonValue parse(const std::string& text) {
    Parser parser(text);
    JsonValue value = parser.parse_value();
    parser.skip_whitespace();
    if (!parser.is_end()) {
      throw std::runtime_error("Unexpected trailing JSON content.");
    }
    return value;
  }

 private:
  class Parser {
   public:
    explicit Parser(const std::string& input) : input_(input), index_(0) {}

    JsonValue parse_value() {
      skip_whitespace();
      if (is_end()) {
        throw std::runtime_error("Unexpected end of JSON input.");
      }

      const char ch = peek();
      if (ch == 'n') {
        consume_literal("null");
        return JsonValue(nullptr);
      }
      if (ch == 't') {
        consume_literal("true");
        return JsonValue(true);
      }
      if (ch == 'f') {
        consume_literal("false");
        return JsonValue(false);
      }
      if (ch == '"') {
        return JsonValue(parse_string());
      }
      if (ch == '{') {
        return JsonValue(parse_object());
      }
      if (ch == '[') {
        return JsonValue(parse_array());
      }
      if (ch == '-' || std::isdigit(static_cast<unsigned char>(ch))) {
        return JsonValue(parse_number());
      }

      throw std::runtime_error("Invalid JSON value.");
    }

    void skip_whitespace() {
      while (!is_end() && std::isspace(static_cast<unsigned char>(input_[index_]))) {
        ++index_;
      }
    }

    bool is_end() const { return index_ >= input_.size(); }

   private:
    const char& peek() const { return input_[index_]; }

    char get() {
      if (is_end()) {
        throw std::runtime_error("Unexpected end of JSON input.");
      }
      return input_[index_++];
    }

    void consume_literal(const char* literal) {
      while (*literal != '\0') {
        if (get() != *literal) {
          throw std::runtime_error("Invalid JSON literal.");
        }
        ++literal;
      }
    }

    std::string parse_string() {
      if (get() != '"') {
        throw std::runtime_error("Expected string.");
      }

      std::string output;
      while (true) {
        const char ch = get();
        if (ch == '"') {
          break;
        }
        if (ch == '\\') {
          output.push_back(parse_escape());
          continue;
        }
        output.push_back(ch);
      }

      return output;
    }

    char parse_escape() {
      const char ch = get();
      switch (ch) {
        case '"':
          return '"';
        case '\\':
          return '\\';
        case '/':
          return '/';
        case 'b':
          return '\b';
        case 'f':
          return '\f';
        case 'n':
          return '\n';
        case 'r':
          return '\r';
        case 't':
          return '\t';
        case 'u':
          return parse_unicode_escape();
        default:
          throw std::runtime_error("Invalid JSON escape sequence.");
      }
    }

    char parse_unicode_escape() {
      unsigned int code = 0;
      for (int count = 0; count < 4; ++count) {
        code <<= 4;
        const char ch = get();
        if (ch >= '0' && ch <= '9') {
          code |= static_cast<unsigned int>(ch - '0');
        } else if (ch >= 'a' && ch <= 'f') {
          code |= static_cast<unsigned int>(ch - 'a' + 10);
        } else if (ch >= 'A' && ch <= 'F') {
          code |= static_cast<unsigned int>(ch - 'A' + 10);
        } else {
          throw std::runtime_error("Invalid unicode escape.");
        }
      }

      if (code <= 0x7F) {
        return static_cast<char>(code);
      }
      return '?';
    }

    double parse_number() {
      const size_t start = index_;
      if (peek() == '-') {
        ++index_;
      }
      while (!is_end() && std::isdigit(static_cast<unsigned char>(peek()))) {
        ++index_;
      }
      if (!is_end() && peek() == '.') {
        ++index_;
        while (!is_end() && std::isdigit(static_cast<unsigned char>(peek()))) {
          ++index_;
        }
      }
      if (!is_end() && (peek() == 'e' || peek() == 'E')) {
        ++index_;
        if (!is_end() && (peek() == '+' || peek() == '-')) {
          ++index_;
        }
        while (!is_end() && std::isdigit(static_cast<unsigned char>(peek()))) {
          ++index_;
        }
      }

      const std::string number_text = input_.substr(start, index_ - start);
      char* end = nullptr;
      const double value = std::strtod(number_text.c_str(), &end);
      if (end == nullptr || *end != '\0') {
        throw std::runtime_error("Invalid JSON number.");
      }
      return value;
    }

    Object parse_object() {
      if (get() != '{') {
        throw std::runtime_error("Expected object.");
      }

      Object output;
      skip_whitespace();
      if (!is_end() && peek() == '}') {
        get();
        return output;
      }

      while (true) {
        skip_whitespace();
        const std::string key = parse_string();
        skip_whitespace();
        if (get() != ':') {
          throw std::runtime_error("Expected ':' in object.");
        }
        JsonValue value = parse_value();
        output.emplace(key, std::move(value));
        skip_whitespace();
        const char delimiter = get();
        if (delimiter == '}') {
          break;
        }
        if (delimiter != ',') {
          throw std::runtime_error("Expected ',' or '}' in object.");
        }
      }

      return output;
    }

    Array parse_array() {
      if (get() != '[') {
        throw std::runtime_error("Expected array.");
      }

      Array output;
      skip_whitespace();
      if (!is_end() && peek() == ']') {
        get();
        return output;
      }

      while (true) {
        output.push_back(parse_value());
        skip_whitespace();
        const char delimiter = get();
        if (delimiter == ']') {
          break;
        }
        if (delimiter != ',') {
          throw std::runtime_error("Expected ',' or ']' in array.");
        }
      }

      return output;
    }

    const std::string& input_;
    size_t index_;
  };

  std::variant<std::nullptr_t, bool, double, std::string, Object, Array> value_;
};

inline long json_number_to_long(const JsonValue& value) {
  return static_cast<long>(value.as_number());
}

}  // namespace rocksolid

#endif
