#include "storage/SdCard.h"

#include <SD.h>

#include "config/AppConfig.h"
#include "config/Pins.h"
#include "util/Log.h"

namespace {

const char* cardTypeName(sdcard_type_t type) {
  switch (type) {
    case CARD_MMC:
      return "MMC";
    case CARD_SD:
      return "SDSC";
    case CARD_SDHC:
      return "SDHC";
    case CARD_NONE:
      return "none";
    default:
      return "unknown";
  }
}

}  // namespace

SdCard::SdCard() : _spi(HSPI) {}

bool SdCard::begin(uint32_t frequency) {
  if (_mounted) {
    return true;
  }

  // Keep the e-Paper deselected while probing the card.
  pinMode(pins::EpdCs, OUTPUT);
  digitalWrite(pins::EpdCs, HIGH);

  _spi.begin(pins::SdSck, pins::SdMiso, pins::SdMosi, pins::SdCs);

  LOG_I("SD: begin() @ %u Hz", (unsigned)frequency);
  if (!SD.begin(pins::SdCs, _spi, frequency)) {
    LOG_E("SD: mount failed @ %u Hz", (unsigned)frequency);
    // Release the bus: with the rail cut, driven lines would feed an unpowered
    // card through its ESD diodes and keep its controller alive.
    SD.end();
    _spi.end();
    return false;
  }

  _mounted = true;
  LOG_I("SD: mounted, %s, %llu MB total, %llu MB used",
        cardTypeName(SD.cardType()),
        SD.totalBytes() / (1024ULL * 1024ULL),
        SD.usedBytes() / (1024ULL * 1024ULL));
  return true;
}

void SdCard::end() {
  if (!_mounted) {
    return;
  }
  SD.end();
  _spi.end();
  _mounted = false;
  LOG_I("SD: unmounted");
}
