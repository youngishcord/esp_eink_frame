#include "app/AppController.h"

#include <SD.h>

#include "config/AppConfig.h"
#include "display/Screens.h"
#include "util/Log.h"

namespace {
constexpr uint32_t kActionDelayMs = 400;   // let the HTTP reply flush first
constexpr uint32_t kReconnectIntervalMs = 30000;
constexpr uint32_t kReconnectTimeoutMs = 10000;
}  // namespace

AppController::AppController() : _web(*this) {}

AppController::~AppController() = default;

void AppController::begin() {
  LOG_I("=== %s %s ===", config::FirmwareName, config::FirmwareVersion);

  _display.begin();

  if (_sd.begin()) {
    _images.begin();
  } else {
    LOG_E("App: SD card unavailable, image features disabled");
  }

  _settings.begin();
  _clock.begin();

  _network.begin();
  handleBootNetwork();

  _web.begin();
}

void AppController::loop() {
  _web.loop();
  processPendingAction();
  maybeSyncClock();
  maybeReconnectStation();
}

void AppController::handleBootNetwork() {
  const WifiCredentials credentials = _settings.wifi();

  bool connected = false;
  if (!credentials.isEmpty()) {
    connected = _network.connect(credentials.ssid, credentials.password,
                                 config::StaConnectTimeoutMs);
  }

  if (connected) {
    _clock.syncFromNtp();
    _lastNtpSync = millis();

    const String last = _settings.lastImage();
    if (_sd.mounted() && !last.isEmpty() && _images.exists(last)) {
      showImage(last);
    } else {
      showConnectedScreen();
    }
    return;
  }

  // No usable network: fall back to the setup access point.
  showProvisioningScreen();
  _network.startAp();
}

void AppController::requestShowImage(const String& name) {
  _action = Action::ShowImage;
  _actionName = ImageRepository::sanitize(name);
  _actionReadyAt = millis() + kActionDelayMs;
}

void AppController::requestWifiChange(const String& ssid,
                                      const String& password) {
  _action = Action::WifiChange;
  _actionSsid = ssid;
  _actionPassword = password;
  _actionReadyAt = millis() + kActionDelayMs;
}

void AppController::requestWifiReset() {
  _action = Action::WifiReset;
  _actionReadyAt = millis() + kActionDelayMs;
}

void AppController::requestStatusScreen() {
  _action = Action::StatusScreen;
  _actionReadyAt = millis() + kActionDelayMs;
}

void AppController::processPendingAction() {
  if (_action == Action::None || millis() < _actionReadyAt) {
    return;
  }

  const Action action = _action;
  _action = Action::None;

  switch (action) {
    case Action::ShowImage:
      showImage(_actionName);
      break;

    case Action::WifiChange: {
      WifiCredentials credentials;
      credentials.ssid = _actionSsid;
      credentials.password = _actionPassword;
      _settings.setWifi(credentials);

      if (_network.connect(credentials.ssid, credentials.password,
                           config::StaConnectTimeoutMs)) {
        _clock.syncFromNtp();
        _lastNtpSync = millis();
        showConnectedScreen();
      } else {
        showProvisioningScreen();
        _network.startAp();
      }
      break;
    }

    case Action::WifiReset:
      _settings.clearWifi();
      _network.disconnectStation();
      showProvisioningScreen();
      _network.startAp();
      break;

    case Action::StatusScreen:
      if (_network.stationConnected()) {
        showConnectedScreen();
      } else {
        showProvisioningScreen();
      }
      break;

    case Action::None:
      break;
  }
}

void AppController::showImage(const String& name) {
  if (!_sd.mounted()) {
    LOG_E("App: cannot show image, SD not mounted");
    return;
  }
  File file = _images.open(name);
  if (!file) {
    LOG_E("App: failed to open image \"%s\"", name.c_str());
    return;
  }

  LOG_I("App: rendering \"%s\" (%u bytes)", name.c_str(), (unsigned)file.size());
  _busy = true;
  _display.showRaw(file, file.size());
  _busy = false;
  file.close();

  _currentImage = name;
  _settings.setLastImage(name);
}

void AppController::showProvisioningScreen() {
  screens::Screen screen;
  screen.title = "WiFi Setup";
  screen.accent = GxEPD_BLUE;
  screen.lines.push_back("Connect to the WiFi:");
  screen.lines.push_back(_network.apSsid());
  screen.lines.push_back(String("Password: ") + config::ApPassword);
  screen.lines.push_back("Then open in a browser:");
  screen.lines.push_back(String("http://") + config::ApDefaultIp);
  screens::show(_display, screen);
}

void AppController::showConnectedScreen() {
  screens::Screen screen;
  screen.title = "Connected";
  screen.accent = GxEPD_GREEN;
  screen.lines.push_back(_network.stationSsid());
  screen.lines.push_back(String("http://") + _network.stationIp());
  screen.lines.push_back("Open the address above");
  screen.footer = _clock.available() ? _clock.format()
                                     : String(config::FirmwareVersion);
  screens::show(_display, screen);
}

void AppController::maybeSyncClock() {
  if (!_network.stationConnected()) {
    return;
  }
  if (millis() - _lastNtpSync < config::NtpSyncIntervalMs) {
    return;
  }
  _lastNtpSync = millis();
  _clock.syncFromNtp();
}

void AppController::maybeReconnectStation() {
  if (_action != Action::None || _network.stationConnected() ||
      _network.apActive()) {
    return;
  }
  const WifiCredentials credentials = _settings.wifi();
  if (credentials.isEmpty()) {
    return;
  }
  if (millis() - _lastReconnectAttempt < kReconnectIntervalMs) {
    return;
  }
  _lastReconnectAttempt = millis();
  LOG_I("Net: attempting to reconnect to \"%s\"", credentials.ssid.c_str());
  if (_network.connect(credentials.ssid, credentials.password,
                       kReconnectTimeoutMs)) {
    _lastNtpSync = millis();
  }
}
