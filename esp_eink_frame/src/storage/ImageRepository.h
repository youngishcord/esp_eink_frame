#pragma once

#include <Arduino.h>
#include <FS.h>

#include <vector>

// Manages the library of images stored on the SD card. Each image is a raw
// Spectra 6 frame (config::FrameBytes bytes, 4 bpp) with a .e6 extension.

struct ImageEntry {
  String name;  // without extension
  size_t size = 0;
};

class ImageRepository {
 public:
  bool begin();

  // Normalises an arbitrary user-supplied name into a safe file stem.
  static String sanitize(const String& raw);

  // "/images/<name>.e6"
  static String pathFor(const String& name);

  std::vector<ImageEntry> list() const;
  bool exists(const String& name) const;
  size_t size(const String& name) const;

  File open(const String& name);
  bool remove(const String& name);
};
