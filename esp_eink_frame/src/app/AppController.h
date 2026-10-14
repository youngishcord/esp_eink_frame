#pragma once

#include <Arduino.h>

#include <vector>

#include "display/Display.h"
#include "net/NetworkManager.h"
#include "rtc/Clock.h"
#include "storage/ImageRepository.h"
#include "storage/SdCard.h"
#include "storage/SettingsStore.h"
#include "web/WebServerApp.h"

// Central coordinator. Owns every subsystem and drives them from loop().
//
// Commands arriving from the web layer (show an image, change network, ...) are
// queued and executed from loop(), never from inside an HTTP handler: a display
// refresh blocks for tens of seconds and would otherwise stall the response.

class AppController {
 public:
  AppController();
  ~AppController();

  void begin();
  void loop();

  // --- Commands (safe to call from an HTTP handler) ---
  void requestShowImage(const String& name);
  void requestWifiChange(const String& ssid, const String& password);
  void requestWifiReset();
  void requestStatusScreen();

  // --- Queries ---
  Display& display() { return _display; }
  NetworkManager& network() { return _network; }
  ImageRepository& images() { return _images; }
  SettingsStore& settings() { return _settings; }
  Clock& clock() { return _clock; }

  bool sdMounted() const { return _sd.mounted(); }
  String currentImage() const { return _currentImage; }
  bool busy() const { return _busy; }

 private:
  enum class Action { None, ShowImage, WifiChange, WifiReset, StatusScreen };

  void handleBootNetwork();
  void processPendingAction();
  void showImage(const String& name);
  void showProvisioningScreen();
  void showConnectedScreen();
  void maybeSyncClock();
  void maybeReconnectStation();

  Display _display;
  SdCard _sd;
  ImageRepository _images;
  SettingsStore _settings;
  Clock _clock;
  NetworkManager _network;
  WebServerApp _web;

  Action _action = Action::None;
  uint32_t _actionReadyAt = 0;
  String _actionName;
  String _actionSsid;
  String _actionPassword;
  String _currentImage;
  bool _busy = false;
  uint32_t _lastNtpSync = 0;
  uint32_t _lastReconnectAttempt = 0;
};
