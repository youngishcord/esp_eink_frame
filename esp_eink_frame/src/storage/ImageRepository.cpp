#include "storage/ImageRepository.h"

#include <SD.h>

#include <algorithm>

#include "config/AppConfig.h"
#include "util/Log.h"

namespace {

constexpr char kMetaName[] = "/meta.tsv";
constexpr char kMetaTempName[] = "/meta.tmp";
constexpr char kFieldSep = '\t';

bool isSafeChar(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
         (c >= '0' && c <= '9') || c == '-' || c == '_';
}

// True for a UTF-8 continuation byte; used to avoid cutting a multi-byte
// character in half when a title is truncated.
bool isContinuation(char c) {
  return (static_cast<uint8_t>(c) & 0xC0) == 0x80;
}

String metaPath() { return String(config::ImagesDirectory) + kMetaName; }

String metaTempPath() { return String(config::ImagesDirectory) + kMetaTempName; }

struct MetaRow {
  String name;
  String title;
};

std::vector<MetaRow> readMeta() {
  std::vector<MetaRow> rows;
  File file = SD.open(metaPath(), FILE_READ);
  if (!file) {
    return rows;  // No sidecar yet: every image is listed under its slug.
  }
  const String content = file.readString();
  file.close();

  size_t start = 0;
  while (start <= content.length()) {
    const int newline = content.indexOf('\n', start);
    const size_t end = newline < 0 ? content.length()
                                   : static_cast<size_t>(newline);
    const String line = content.substring(start, end);
    const int sep = line.indexOf(kFieldSep);
    if (sep > 0) {
      MetaRow row;
      row.name = line.substring(0, sep);
      row.name.trim();
      row.title = ImageRepository::sanitizeTitle(line.substring(sep + 1));
      if (!row.name.isEmpty() && !row.title.isEmpty()) {
        rows.push_back(row);
      }
    }
    if (newline < 0) {
      break;
    }
    start = static_cast<size_t>(newline) + 1;
  }
  return rows;
}

// Rewrites the whole table through a temporary file so an interrupted write
// cannot leave the library without its titles.
bool writeMeta(const std::vector<MetaRow>& rows) {
  File file = SD.open(metaTempPath(), FILE_WRITE);
  if (!file) {
    LOG_E("Images: cannot write %s", metaTempPath().c_str());
    return false;
  }
  for (const MetaRow& row : rows) {
    file.print(row.name);
    file.print(kFieldSep);
    file.println(row.title);
  }
  file.close();

  SD.remove(metaPath());
  if (!SD.rename(metaTempPath(), metaPath())) {
    LOG_E("Images: cannot update %s", metaPath().c_str());
    SD.remove(metaTempPath());
    return false;
  }
  return true;
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

String ImageRepository::sanitizeTitle(const String& raw) {
  String clean;
  clean.reserve(raw.length());
  bool pendingSpace = false;
  for (size_t i = 0; i < raw.length(); ++i) {
    const char c = raw[i];
    if (c == ' ' || c == '\t' || c == '\r' || c == '\n' ||
        static_cast<uint8_t>(c) < 0x20) {
      pendingSpace = !clean.isEmpty();
      continue;
    }
    if (clean.length() >= config::MaxImageTitleLength) {
      break;
    }
    if (pendingSpace) {
      clean += ' ';
      pendingSpace = false;
    }
    clean += c;
  }
  while (!clean.isEmpty() && isContinuation(clean[clean.length() - 1])) {
    clean.remove(clean.length() - 1);
  }
  return clean;
}

String ImageRepository::pathFor(const String& name) {
  return String(config::ImagesDirectory) + "/" + name + config::ImageExtension;
}

std::vector<ImageEntry> ImageRepository::list() const {
  const std::vector<MetaRow> meta = readMeta();
  auto lookup = [&meta](const String& name) -> String {
    for (const MetaRow& row : meta) {
      if (row.name == name) {
        return row.title;
      }
    }
    return String();
  };

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
        item.mtime = static_cast<uint32_t>(entry.getLastWrite());
        item.title = lookup(item.name);
        if (item.title.isEmpty()) {
          item.title = item.name;
        }
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
  const bool removed = SD.remove(pathFor(name));
  if (removed && !titleOf(name).isEmpty()) {
    std::vector<MetaRow> rows = readMeta();
    rows.erase(std::remove_if(rows.begin(), rows.end(),
                              [&name](const MetaRow& row) {
                                return row.name == name;
                              }),
               rows.end());
    writeMeta(rows);
  }
  return removed;
}

String ImageRepository::freeName(const String& stem) {
  String base = stem.isEmpty() ? String("image") : stem;
  if (!SD.exists(pathFor(base))) {
    return base;
  }
  for (uint32_t i = 2; i < 1000; ++i) {
    const String candidate = base + "-" + String(static_cast<unsigned long>(i));
    if (candidate.length() <= config::MaxImageNameLength &&
        !SD.exists(pathFor(candidate))) {
      return candidate;
    }
  }
  return base;
}

String ImageRepository::titleOf(const String& name) {
  for (const MetaRow& row : readMeta()) {
    if (row.name == name) {
      return row.title;
    }
  }
  return String();
}

bool ImageRepository::setTitle(const String& name, const String& title) {
  if (name.isEmpty()) {
    return false;
  }
  const String clean = sanitizeTitle(title);
  std::vector<MetaRow> rows = readMeta();
  bool found = false;
  for (MetaRow& row : rows) {
    if (row.name == name) {
      row.title = clean;
      found = true;
      break;
    }
  }
  if (!found && !clean.isEmpty()) {
    rows.push_back({name, clean});
  }
  if (!found && clean.isEmpty()) {
    return true;  // Nothing stored, nothing to clear.
  }
  rows.erase(std::remove_if(rows.begin(), rows.end(),
                            [](const MetaRow& row) {
                              return row.name.isEmpty() || row.title.isEmpty();
                            }),
             rows.end());
  return writeMeta(rows);
}
