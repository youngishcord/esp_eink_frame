#include "rtc/Clock.h"

#include <Wire.h>
#include <time.h>

#include "config/Pins.h"
#include "util/Log.h"

bool Clock::begin() {
  Wire.begin(pins::RtcSda, pins::RtcScl);
  if (!_rtc.begin()) {
    LOG_W("RTC: DS3231 not found (check SDA/SCL wiring)");
    _available = false;
    return false;
  }
  _available = true;

  if (_rtc.lostPower()) {
    LOG_W("RTC: lost power, setting from build time");
    _rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
  }
  LOG_I("RTC: DS3231 ready, %s", format().c_str());
  return true;
}

DateTime Clock::now() {
  if (_available) {
    return _rtc.now();
  }
  return DateTime(2020, 1, 1, 0, 0, 0);
}

String Clock::format(const char* pattern) {
  const DateTime t = now();
  char buffer[32];
  snprintf(buffer, sizeof(buffer), pattern, t.year(), t.month(), t.day(),
           t.hour(), t.minute(), t.second());
  return String(buffer);
}

bool Clock::syncFromNtp(uint32_t timeoutMs) {
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");

  const uint32_t start = millis();
  time_t utc = time(nullptr);
  while (utc < 100000 && millis() - start < timeoutMs) {
    delay(200);
    utc = time(nullptr);
  }
  if (utc < 100000) {
    LOG_W("NTP: sync timed out");
    return false;
  }

  if (_available) {
    _rtc.adjust(DateTime(static_cast<uint32_t>(utc)));
  }
  struct tm timeInfo;
  gmtime_r(&utc, &timeInfo);
  LOG_I("NTP: synced to %04d-%02d-%02d %02d:%02d:%02d UTC",
        timeInfo.tm_year + 1900, timeInfo.tm_mon + 1, timeInfo.tm_mday,
        timeInfo.tm_hour, timeInfo.tm_min, timeInfo.tm_sec);
  return true;
}
