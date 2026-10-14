#pragma once

#include <Arduino.h>
#include <RTClib.h>

// Thin wrapper around the DS3231. Reports availability so the rest of the app
// can degrade gracefully when the RTC is absent.

class Clock {
 public:
  // Initialises I2C and probes the RTC. Returns true if a chip was found.
  bool begin();

  bool available() const { return _available; }

  DateTime now();

  // Convenience formatting, e.g. "2026-10-14 09:30".
  String format(const char* pattern = "%Y-%m-%d %H:%M");

  // Fetches the time over NTP (requires an active WiFi connection) and stores
  // it into the RTC. Returns true on success.
  bool syncFromNtp(uint32_t timeoutMs = 15000);

 private:
  RTC_DS3231 _rtc;
  bool _available = false;
};
