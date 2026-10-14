#include "storage/SdCard.h"

#include <SD.h>

#include "config/AppConfig.h"
#include "config/Pins.h"
#include "util/Log.h"

namespace {
// Try slow to fast; the card must answer at the lowest speed if wiring is OK.
constexpr uint32_t kFrequencies[] = {400000, 1000000, 4000000, 10000000};
}  // namespace

SdCard::SdCard() : _spi(HSPI) {}

bool SdCard::begin() {
  if (_mounted) {
    return true;
  }

  // Keep the e-Paper deselected while probing the card.
  pinMode(pins::EpdCs, OUTPUT);
  digitalWrite(pins::EpdCs, HIGH);

  _spi.begin(pins::SdSck, pins::SdMiso, pins::SdMosi, pins::SdCs);

  for (uint32_t freq : kFrequencies) {
    SD.end();
    LOG_I("SD: begin() @ %u Hz", (unsigned)freq);
    if (SD.begin(pins::SdCs, _spi, freq)) {
      _mounted = true;
      break;
    }
  }

  if (!_mounted) {
    LOG_E("SD: card did not respond at any speed");
    return false;
  }

  LOG_I("SD: mounted, %llu MB total, %llu MB used",
        SD.totalBytes() / (1024ULL * 1024ULL),
        SD.usedBytes() / (1024ULL * 1024ULL));
  return true;
}
