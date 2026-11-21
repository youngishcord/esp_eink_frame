#pragma once

#include <Arduino.h>
#include <SPI.h>

// Mounts the microSD card on its dedicated HSPI bus.
//
// One attempt per call, at the given clock, mirroring the standalone bring-up
// sketch that is known to work on this hardware. A failed attempt tears the bus
// down again; the caller decides whether to power-cycle the rail and retry.

class SdCard {
 public:
  SdCard();

  // Returns true once the card is mounted.
  bool begin(uint32_t frequency);

  // Unmounts the card and releases the HSPI bus. The card forgets everything, so
  // begin() must run again after the rail is powered back up.
  void end();

  bool mounted() const { return _mounted; }

  SPIClass& bus() { return _spi; }

 private:
  SPIClass _spi;
  bool _mounted = false;
};
