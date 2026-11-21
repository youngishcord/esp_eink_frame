#include "power/DeepSleep.h"

#include <Arduino.h>
#include <driver/gpio.h>
#include <driver/rtc_io.h>
#include <esp_sleep.h>

#include "config/Pins.h"
#include "power/PowerRail.h"
#include "util/Log.h"

namespace {

constexpr gpio_num_t kRtcInt = static_cast<gpio_num_t>(pins::RtcInt);
constexpr gpio_num_t kStatusLed = static_cast<gpio_num_t>(pins::StatusLed);

// Lines that drive the two loads on the switched rail. They are parked at 0 V
// before the rail is cut: a high level on an unpowered input would push current
// through the load's ESD protection diode and partially power it again.
constexpr int kParkedLow[] = {
    pins::EpdSck, pins::EpdMosi, pins::EpdCs, pins::EpdDc, pins::EpdRst,
    pins::SdSck,  pins::SdMosi,  pins::SdCs,
};

void parkPeripheralLines() {
  for (int pin : kParkedLow) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
  }
  // Inputs from the peripherals: plain inputs, no pull-ups that would leak into
  // an unpowered load.
  pinMode(pins::EpdBusy, INPUT);
  pinMode(pins::SdMiso, INPUT);
}

}  // namespace

namespace power {

bool wokeFromWakeLine() {
  return esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0;
}

void prepareRtcAlarmWake() {
  pinMode(pins::RtcInt, INPUT_PULLUP);
  // RTC GPIO pull-up must be enabled explicitly so the open-drain INT line
  // (DS3231 alarm output and the wake button hang off it) stays high while the
  // digital domain is powered down.
  rtc_gpio_pulldown_dis(kRtcInt);
  rtc_gpio_pullup_en(kRtcInt);
  // ext0 needs the RTC peripherals (and therefore the RTC IO pull-ups) to stay
  // powered while the rest of the chip sleeps.
  esp_sleep_pd_config(ESP_PD_DOMAIN_RTC_PERIPH, ESP_PD_OPTION_ON);
  esp_sleep_enable_ext0_wakeup(kRtcInt, 0);  // wake when INT is pulled low
  LOG_I("Sleep: wake source = DS3231 INT / button on GPIO%d", pins::RtcInt);
}

void statusLedOn() {
  gpio_hold_dis(kStatusLed);
  pinMode(pins::StatusLed, OUTPUT);
  digitalWrite(pins::StatusLed, HIGH);
}

void deepSleep() {
  parkPeripheralLines();
  power::railOff();
  // The LED marks "the board is awake": drive it low and hold the pad there
  // so the frame goes visibly dark even if the resistor were missing.
  pinMode(pins::StatusLed, OUTPUT);
  digitalWrite(pins::StatusLed, LOW);
  gpio_hold_en(kStatusLed);
  // Apply the gate hold (and any other holds) while the digital domain is down.
  gpio_deep_sleep_hold_en();

  LOG_I("Sleep: SD and e-Paper unpowered, entering deep sleep");
  Serial.flush();
  delay(20);

  esp_deep_sleep_start();
  // [[noreturn]]: esp_deep_sleep_start() never returns.
}

}  // namespace power
