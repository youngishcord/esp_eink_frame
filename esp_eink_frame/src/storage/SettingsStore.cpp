#include "storage/SettingsStore.h"

#include "util/Log.h"

namespace {
constexpr char kNamespace[] = "einkframe";
constexpr char kKeySsid[] = "wifi_ssid";
constexpr char kKeyPassword[] = "wifi_pass";
constexpr char kKeyLastImage[] = "last_image";
}  // namespace

bool SettingsStore::begin() {
  const bool ok = _prefs.begin(kNamespace, false);
  if (!ok) {
    LOG_E("Settings: failed to open NVS namespace");
  }
  return ok;
}

WifiCredentials SettingsStore::wifi() const {
  WifiCredentials credentials;
  credentials.ssid = _prefs.getString(kKeySsid, "");
  credentials.password = _prefs.getString(kKeyPassword, "");
  return credentials;
}

void SettingsStore::setWifi(const WifiCredentials& credentials) {
  _prefs.putString(kKeySsid, credentials.ssid);
  _prefs.putString(kKeyPassword, credentials.password);
  LOG_I("Settings: saved WiFi credentials for \"%s\"", credentials.ssid.c_str());
}

void SettingsStore::clearWifi() {
  _prefs.remove(kKeySsid);
  _prefs.remove(kKeyPassword);
  LOG_I("Settings: cleared WiFi credentials");
}

String SettingsStore::lastImage() const {
  return _prefs.getString(kKeyLastImage, "");
}

void SettingsStore::setLastImage(const String& name) {
  _prefs.putString(kKeyLastImage, name);
}
