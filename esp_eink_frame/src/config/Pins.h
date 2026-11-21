#pragma once

// Physical wiring of the ESP32 (see the project README for the full tables).
//
// The e-Paper HAT and the SD card live on *separate* hardware SPI buses on
// purpose: the HAT's always-connected TXB0108 level translator disturbs a
// shared bus whenever the HAT is powered, which breaks SD initialisation.

namespace pins {

// --- E-ink display on VSPI ---
constexpr int EpdSck = 18;
constexpr int EpdMosi = 23;
constexpr int EpdCs = 33;
constexpr int EpdDc = 17;
constexpr int EpdRst = 16;
constexpr int EpdBusy = 22;

// --- SD card on HSPI ---
constexpr int SdSck = 14;
constexpr int SdMosi = 13;
constexpr int SdMiso = 27;
constexpr int SdCs = 5;

// --- Switched 3.3 V rail for the SD card and the e-Paper HAT ---
// Drives a high-side switch with a pull-up to 3.3 V on its control input, so
// the hardware default (reset, deep sleep, floating pin) is "off":
//   pin LOW  -> rail powered
//   pin HIGH -> rail cut
// Works unchanged with a P-channel MOSFET (gate) or a PNP transistor (base,
// through 220 Ohm). Must not be a strapping pin; GPIO4 is a free RTC GPIO.
// See config::PowerGateActiveHigh to invert the logic.
constexpr int PowerGate = 4;

// --- DS3231 RTC on the alternate I2C bus ---
// GPIO 21/19 are reserved for other peripherals on this build, so the RTC uses
// the free 25/26 pair instead.
constexpr int RtcSda = 25;
constexpr int RtcScl = 26;
// SQW/INT from the DS3231. Must be an RTC GPIO so it can wake the ESP32 from
// deep sleep; GPIO32 is a good free choice on a WROOM module. The forced
// wake-up button is wired in parallel on this same line (see below).
constexpr int RtcInt = 32;

// --- Forced wake-up button ---
// Momentary push button between GPIO32 and GND, in parallel with the DS3231
// INT output. Both are open-drain active-low, so they share the pull-up
// without contention. The classic ESP32 cannot do this any other way: ext0
// takes a single pin and ext1 cannot OR several active-low inputs together.
// The firmware tells an alarm wake from a button wake by the latched A1 flag
// in the DS3231, so this constant just documents the shared line.
constexpr int BtnWake = RtcInt;

// --- Sleep status LED ---
// LED from the pin through ~330 Ohm to GND (active high): lit while the
// firmware runs, dark in deep sleep. deepSleep() drives the pin low and holds
// it there before the chip stops, so the LED never leaks current while
// sleeping. GPIO2 is a strapping pin: the LED load pulls it low at boot,
// which is exactly the level GPIO2 must sample. Do not wire the LED to 3.3 V
// (active low) - that would hold the pin high during boot.
constexpr int StatusLed = 2;

}  // namespace pins
