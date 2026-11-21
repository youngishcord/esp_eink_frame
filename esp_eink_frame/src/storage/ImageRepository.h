#pragma once

#include <Arduino.h>
#include <FS.h>

#include <vector>

// Manages the library of images stored on the SD card. Each image is a raw
// Spectra 6 frame (config::FrameBytes bytes, 4 bpp) with a .e6 extension.
//
// A file is addressed by its slug: the ASCII stem the whole API and the FAT
// file system use. The human-readable title shown in the web UI ("Море летом")
// lives in a sidecar table - "/images/meta.tsv", one "<slug>\t<title>" per line
// - so titles can use any alphabet without touching FAT naming rules.

struct ImageEntry {
  String name;    // slug, without extension
  String title;   // display name, falls back to the slug
  size_t size = 0;
  uint32_t mtime = 0;  // last write in unix seconds, 0 when unknown
};

class ImageRepository {
 public:
  bool begin();

  // Normalises an arbitrary user-supplied name into a safe file stem.
  static String sanitize(const String& raw);

  // Normalises a display title: one line, no tabs, no double spaces, limited
  // length. Multi-byte UTF-8 sequences are kept whole.
  static String sanitizeTitle(const String& raw);

  // "/images/<name>.e6"
  static String pathFor(const String& name);

  std::vector<ImageEntry> list() const;
  bool exists(const String& name) const;
  size_t size(const String& name) const;

  File open(const String& name);
  bool remove(const String& name);

  // First free slug derived from `stem`: stem, stem-2, stem-3, ...
  static String freeName(const String& stem);

  // Stores the display name of an image. An empty title drops the entry, which
  // makes the image fall back to its slug.
  static bool setTitle(const String& name, const String& title);
  static String titleOf(const String& name);
};
