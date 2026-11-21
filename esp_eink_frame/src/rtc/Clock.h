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

  // Programs alarm 1 to fire `seconds` from now and routes it to the SQW/INT
  // pin as an active-low interrupt (needed for ESP32 deep-sleep wake-up).
  bool setAlarmIn(uint32_t seconds);

  // Clears the latched alarm flag and disables alarm 1. The INT pin is released
  // (pulled high) by this call.
  void clearAlarm();

  bool alarmFired();

  // True when begin() found alarm 1 already latched in the DS3231, i.e. the
  // alarm fired while the board was asleep. begin() clears the flag, so this
  // is the only way to tell an alarm wake from a wake-button press afterwards:
  // both pull the shared INT line low.
  bool alarmWasFired() const { return _alarmWasFired; }

 private:
  RTC_DS3231 _rtc;
  bool _available = false;
  bool _alarmWasFired = false;
};
