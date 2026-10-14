#include "storage/ImageRepository.h"

#include <SD.h>

#include "config/AppConfig.h"
#include "util/Log.h"

namespace {

bool isSafeChar(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
         (c >= '0' && c <= '9') || c == '-' || c == '_';
}

}  // namespace

bool ImageRepository::begin() {
  if (SD.exists(config::ImagesDirectory)) {
    return true;
  }
  if (!SD.mkdir(config::ImagesDirectory)) {
    LOG_E("Images: failed to create %s", config::ImagesDirectory);
    return false;
  }
  LOG_I("Images: created %s", config::ImagesDirectory);
  return true;
}

String ImageRepository::sanitize(const String& raw) {
  String name = raw;
  name.trim();
  // Drop a trailing extension if the client sent one.
  const int dot = name.lastIndexOf('.');
  if (dot > 0) {
    name = name.substring(0, dot);
  }

  String clean;
  clean.reserve(name.length());
  for (size_t i = 0; i < name.length(); ++i) {
    const char c = name[i];
    if (isSafeChar(c)) {
      clean += c;
    } else if (c == ' ') {
      clean += '_';
    }
  }
  if (clean.length() > config::MaxImageNameLength) {
    clean = clean.substring(0, config::MaxImageNameLength);
  }
  return clean;
}

String ImageRepository::pathFor(const String& name) {
  return String(config::ImagesDirectory) + "/" + name + config::ImageExtension;
}

std::vector<ImageEntry> ImageRepository::list() const {
  std::vector<ImageEntry> entries;
  File dir = SD.open(config::ImagesDirectory);
  if (!dir) {
    LOG_W("Images: failed to open %s", config::ImagesDirectory);
    return entries;
  }
  File entry = dir.openNextFile();
  while (entry) {
    if (!entry.isDirectory()) {
      String fileName = entry.name();
      // Depending on core version this may include the directory prefix.
      const int slash = fileName.lastIndexOf('/');
      if (slash >= 0) {
        fileName = fileName.substring(slash + 1);
      }
      if (fileName.endsWith(config::ImageExtension)) {
        ImageEntry item;
        item.name = fileName.substring(0, fileName.length() -
                                               strlen(config::ImageExtension));
        item.size = entry.size();
        entries.push_back(item);
      }
    }
    entry.close();
    entry = dir.openNextFile();
  }
  dir.close();
  return entries;
}

bool ImageRepository::exists(const String& name) const {
  return SD.exists(pathFor(name));
}

size_t ImageRepository::size(const String& name) const {
  File file = SD.open(pathFor(name), FILE_READ);
  if (!file) {
    return 0;
  }
  const size_t len = file.size();
  file.close();
  return len;
}

File ImageRepository::open(const String& name) {
  return SD.open(pathFor(name), FILE_READ);
}

bool ImageRepository::remove(const String& name) {
  return SD.remove(pathFor(name));
}
