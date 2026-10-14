#pragma once

#include <Arduino.h>
#include <Preferences.h>

// Persistent device settings backed by NVS. Only small scalar/string values
// belong here; image data lives on the SD card.

struct WifiCredentials {
  String ssid;
  String password;

  bool isEmpty() const { return ssid.isEmpty(); }
};

class SettingsStore {
 public:
  bool begin();

  WifiCredentials wifi() const;
  void setWifi(const WifiCredentials& credentials);
  void clearWifi();

  String lastImage() const;
  void setLastImage(const String& name);

 private:
  mutable Preferences _prefs;
};
