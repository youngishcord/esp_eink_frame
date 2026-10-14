#pragma once

#include <Arduino.h>
#include <SPI.h>
#include <Stream.h>

#include <GxEPD2_7C.h>

#include "config/AppConfig.h"

// High level display façade built on GxEPD2. Owns the VSPI bus and the panel
// driver; storage/UI code never talks to the panel registers directly.
//
// The Waveshare 7.3" e-Paper HAT (E) is an E Ink Spectra 6 panel driven by the
// GDEP073E01 controller, which GxEPD2 supports natively.

namespace display {

// Paged driver: the panel is rendered one horizontal band at a time so the RAM
// footprint stays small (a full 4bpp frame is 192000 bytes, far more than we
// want to hold next to the WiFi stack).
using Gfx = GxEPD2_7C<GxEPD2_730c_GDEP073E01, config::EpdPageHeight>;
using DrawCallback = void (*)(Gfx& gfx, const void* ctx);

}  // namespace display

class Display {
 public:
  Display();

  // Brings up the bus and resets the panel. Blocking; does not clear the screen.
  bool begin();

  bool ready() const { return _ready; }

  // Runs a paged full-screen draw. `draw` is invoked once per band with the
  // Adafruit_GFX surface to render into; the refresh happens at the end.
  void drawPages(display::DrawCallback draw, const void* ctx);

  // Streams a packed 4bpp frame (config::FrameBytes bytes, GxEPD2 logical colour
  // codes) from any source and refreshes the panel.
  bool showRaw(Stream& source, size_t length);

  // Puts the panel to deep sleep (minimal power draw until the next reset).
  void sleep();

 private:
  display::Gfx _gfx;
  SPIClass _spi;
  bool _ready = false;
};
