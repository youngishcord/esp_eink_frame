#pragma once

#include <Arduino.h>

// Tiny logging façade over Serial. Kept header-only and macro-based so it costs
// nothing when disabled and adds no link-time dependencies.

namespace applog {

inline void begin(uint32_t baud = 115200) {
  Serial.begin(baud);
}

}  // namespace applog

#define LOG_I(fmt, ...) \
  Serial.printf("[%8lu][I] " fmt "\n", (unsigned long)millis(), ##__VA_ARGS__)
#define LOG_W(fmt, ...) \
  Serial.printf("[%8lu][W] " fmt "\n", (unsigned long)millis(), ##__VA_ARGS__)
#define LOG_E(fmt, ...) \
  Serial.printf("[%8lu][E] " fmt "\n", (unsigned long)millis(), ##__VA_ARGS__)
