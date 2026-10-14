#include "display/Screens.h"

#include "config/AppConfig.h"
#include "util/Log.h"

namespace {

constexpr int kWidth = config::DisplayWidth;
constexpr int kHeight = config::DisplayHeight;

constexpr int kHeaderHeight = 96;
constexpr int kTitleScale = 6;
constexpr int kBodyScale = 3;
constexpr int kBodyTop = 170;
constexpr int kLineSpacing = 60;

// Adafruit_GFX built-in font cell size (5x7 glyph in a 6x8 box).
constexpr int kGlyphW = 6;
constexpr int kGlyphH = 8;

uint16_t contrastFor(uint16_t background) {
  // Yellow and white are light: use black ink, otherwise white ink.
  return (background == GxEPD_YELLOW || background == GxEPD_WHITE) ? GxEPD_BLACK
                                                                   : GxEPD_WHITE;
}

void drawCentered(display::Gfx& gfx, int y, const String& text, uint16_t color,
                  int scale) {
  gfx.setTextColor(color);
  gfx.setTextSize(scale);
  const int w = static_cast<int>(text.length()) * kGlyphW * scale;
  gfx.setCursor((kWidth - w) / 2, y);
  gfx.print(text);
}

void render(display::Gfx& gfx, const void* ctx) {
  const auto& screen = *static_cast<const screens::Screen*>(ctx);

  gfx.fillScreen(GxEPD_WHITE);

  // Header band with the title.
  gfx.fillRect(0, 0, kWidth, kHeaderHeight, screen.accent);
  drawCentered(gfx, (kHeaderHeight - kGlyphH * kTitleScale) / 2, screen.title,
               contrastFor(screen.accent), kTitleScale);

  // Body lines.
  int y = kBodyTop;
  for (const String& line : screen.lines) {
    if (y + kGlyphH * kBodyScale > kHeight - 40) {
      break;
    }
    drawCentered(gfx, y, line, GxEPD_BLACK, kBodyScale);
    y += kLineSpacing;
  }

  // Footer.
  String footer = screen.footer;
  if (footer.isEmpty()) {
    footer = String(config::FirmwareName) + " " + config::FirmwareVersion;
  }
  gfx.setTextColor(GxEPD_BLACK);
  gfx.setTextSize(2);
  gfx.setCursor(24, kHeight - 30);
  gfx.print(footer);
}

}  // namespace

namespace screens {

void show(Display& display, const Screen& screen) {
  display.drawPages(render, &screen);
}

}  // namespace screens
