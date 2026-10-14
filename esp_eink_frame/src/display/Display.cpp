#include "display/Display.h"

#include "config/Pins.h"
#include "util/Log.h"

namespace {
constexpr uint32_t kSpiFrequency = 4000000;
constexpr uint16_t kWidth = config::DisplayWidth;
constexpr uint16_t kHeight = config::DisplayHeight;
constexpr uint16_t kPageHeight = config::EpdPageHeight;
constexpr size_t kRowBytes = kWidth / 2;
constexpr size_t kPageBytes = kRowBytes * kPageHeight;
}  // namespace

Display::Display()
    : _gfx(GxEPD2_730c_GDEP073E01(pins::EpdCs, pins::EpdDc, pins::EpdRst,
                                   pins::EpdBusy)),
      _spi(VSPI) {}

bool Display::begin() {
  LOG_I("Display: init e-Paper (Spectra 6, %ux%u, page %u)", kWidth, kHeight,
        kPageHeight);

  // Pre-initialise the bus with our pins. GxEPD2 calls SPI.begin() internally
  // during init(), but that becomes a no-op once the bus is already started, so
  // it cannot reset the bus to default pins (which would collide with the RTC
  // SCL on GPIO19 and the SD CS on GPIO5).
  _spi.begin(pins::EpdSck, -1, pins::EpdMosi, -1);
  _gfx.epd2.selectSPI(_spi, SPISettings(kSpiFrequency, MSBFIRST, SPI_MODE0));
  _gfx.init(115200, true, 2, false);

  _ready = true;
  LOG_I("Display: panel ready");
  return true;
}

void Display::drawPages(display::DrawCallback draw, const void* ctx) {
  if (!_ready) {
    LOG_E("Display: drawPages before begin()");
    return;
  }
  _gfx.setFullWindow();
  _gfx.firstPage();
  do {
    draw(_gfx, ctx);
  } while (_gfx.nextPage());
}

bool Display::showRaw(Stream& source, size_t length) {
  if (!_ready || length != config::FrameBytes) {
    LOG_E("Display: showRaw with invalid length %u", (unsigned)length);
    return false;
  }

  uint8_t* page = static_cast<uint8_t*>(malloc(kPageBytes));
  if (!page) {
    LOG_E("Display: unable to allocate %u byte page buffer (free %u)",
          (unsigned)kPageBytes, (unsigned)ESP.getFreeHeap());
    return false;
  }

  bool ok = true;
  for (uint16_t y = 0; y < kHeight; y += kPageHeight) {
    const uint16_t h = (kHeight - y < kPageHeight) ? (kHeight - y) : kPageHeight;
    const size_t n = kRowBytes * h;
    if (source.readBytes(page, n) != n) {
      LOG_E("Display: short read at row %u", y);
      ok = false;
      break;
    }
    _gfx.epd2.writeNative(page, nullptr, 0, y, kWidth, h);
  }

  if (ok) {
    _gfx.epd2.refresh(false);
    _gfx.epd2.powerOff();
  }

  free(page);
  return ok;
}

void Display::sleep() {
  if (_ready) {
    _gfx.hibernate();
  }
}
