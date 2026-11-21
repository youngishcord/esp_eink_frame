#pragma once

// Deep-sleep helpers. The DS3231 alarm output and the forced wake-up button
// share one active-low line (ext0 on the RTC INT GPIO), so the CPU only runs
// while the frame is refreshing and can always be woken by hand. Which of the
// two pulled the line is told apart by the latched alarm flag in the DS3231.
//
// The SD card and the e-Paper HAT sit on a switched rail (see power/PowerRail.h)
// that is cut just before the CPU stops, so they draw no current while sleeping.

namespace power {

// True when the last boot was caused by a falling edge on the shared wake
// line: either the DS3231 alarm or a button press. Combine with
// Clock::alarmWasFired() to tell the two apart.
bool wokeFromWakeLine();

// Configures the INT pin with a pull-up and registers it as the ext0 wake
// source. Must be called immediately before entering deep sleep.
void prepareRtcAlarmWake();

// Drives the status LED high: the board is awake. Call first thing on boot.
void statusLedOn();

// Parks the peripheral signal lines at 0 V, switches the status LED off, cuts
// the shared SD/e-Paper rail and enters deep sleep. Does not return.
[[noreturn]] void deepSleep();

}  // namespace power
