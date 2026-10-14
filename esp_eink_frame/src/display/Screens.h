#pragma once

#include <Arduino.h>

#include <vector>

#include "display/Display.h"

// Small composition helpers for full-screen status pages. All functions block
// for the duration of an e-Paper refresh.
//
// A Screen is a title plus a list of body lines. Everything is centred; keep
// lines under ~30 characters for the default scale.

namespace screens {

struct Screen {
  String title;
  uint16_t accent = GxEPD_BLUE;
  std::vector<String> lines;
  String footer;
};

void show(Display& display, const Screen& screen);

}  // namespace screens
