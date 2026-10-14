#pragma once

#include <Arduino.h>
#include <SPI.h>

// Mounts the microSD card on its dedicated HSPI bus. The card is tried at a few
// decreasing frequencies, because marginal wiring often only answers at the
// lower speeds.

class SdCard {
 public:
  SdCard();

  // Returns true once the card is mounted.
  bool begin();
  bool mounted() const { return _mounted; }

  SPIClass& bus() { return _spi; }

 private:
  SPIClass _spi;
  bool _mounted = false;
};
