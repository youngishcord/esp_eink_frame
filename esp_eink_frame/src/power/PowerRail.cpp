#include "power/PowerRail.h"

#include <Arduino.h>
#include <driver/gpio.h>

#include "config/AppConfig.h"
#include "config/Pins.h"
#include "util/Log.h"

namespace {

constexpr gpio_num_t kGate = static_cast<gpio_num_t>(pins::PowerGate);

// Same logic levels as the hardware default: with the pin floating (reset,
// deep sleep) the rail is off.
constexpr int kOnLevel = config::PowerGateActiveHigh ? HIGH : LOW;
constexpr int kOffLevel = config::PowerGateActiveHigh ? LOW : HIGH;

bool sPowered = false;

void setRail(bool on) {
  if (on == sPowered) {
    return;
  }

  // While a hold is active the pad ignores writes, so drop it first.
  gpio_hold_dis(kGate);
  pinMode(pins::PowerGate, OUTPUT);
  digitalWrite(pins::PowerGate, on ? kOnLevel : kOffLevel);

  if (on) {
    delay(config::PowerRailSettleMs);
  } else {
    // Keep the switch off once the digital domain is powered down, so the rail
    // stays off even if the external pull resistor is missing.
    gpio_hold_en(kGate);
  }

  sPowered = on;
  LOG_I("Power: SD + e-Paper rail %s (gate GPIO%d reads %d)", on ? "on" : "off",
        pins::PowerGate, digitalRead(pins::PowerGate));
}

}  // namespace

namespace power {

void begin() {
  gpio_deep_sleep_hold_dis();
  setRail(true);
}

void railOff() { setRail(false); }

void cycleRail() {
  railOff();
  // Most cards need VCC below ~0.5 V for a few milliseconds before their
  // internal controller resets; 300 ms also covers the module's bulk capacitors.
  delay(300);
  setRail(true);
}

}  // namespace power
