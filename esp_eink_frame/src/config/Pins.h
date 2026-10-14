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

// --- DS3231 RTC on I2C ---
constexpr int RtcSda = 21;
constexpr int RtcScl = 19;

}  // namespace pins
