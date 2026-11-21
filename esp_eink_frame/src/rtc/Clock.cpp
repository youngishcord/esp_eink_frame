#include "rtc/Clock.h"

#include <Wire.h>
#include <time.h>

#include "config/Pins.h"
#include "util/Log.h"

bool Clock::begin() {
  Wire.begin(pins::RtcSda, pins::RtcScl);
  // The DS3231 interrupt output is open drain; keep it high when idle.
  pinMode(pins::RtcInt, INPUT_PULLUP);
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

  // A latched alarm keeps the open-drain INT line low. Release it on every
  // boot; an autonomy cycle arms a fresh alarm right before sleeping. The
  // flag is remembered so the app can tell an alarm wake from a button press.
  const bool alarmWasFired = _rtc.alarmFired(1);
  _alarmWasFired = alarmWasFired;
  _rtc.disableAlarm(1);
  _rtc.clearAlarm(1);
  if (alarmWasFired) {
    LOG_I("RTC: cleared latched alarm 1");
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

bool Clock::setAlarmIn(uint32_t seconds) {
  if (!_available) {
    return false;
  }

  const DateTime when = _rtc.now() + TimeSpan(seconds);

  // DS3231_OFF keeps INTCON set, which is what routes alarm 1 to the INT pin.
  // (RTClib refuses to program an alarm while INTCON is clear.)
  _rtc.writeSqwPinMode(DS3231_OFF);
  _rtc.disableAlarm(1);
  _rtc.clearAlarm(1);

  const bool ok = _rtc.setAlarm1(when, DS3231_A1_Date);
  if (ok) {
    LOG_I("RTC: alarm 1 armed for %04d-%02d-%02d %02d:%02d:%02d",
          when.year(), when.month(), when.day(), when.hour(), when.minute(),
          when.second());
  } else {
    LOG_E("RTC: failed to arm alarm 1");
  }
  return ok;
}

void Clock::clearAlarm() {
  if (!_available) {
    return;
  }
  _rtc.disableAlarm(1);
  _rtc.clearAlarm(1);
}

bool Clock::alarmFired() {
  return _available && _rtc.alarmFired(1);
}
