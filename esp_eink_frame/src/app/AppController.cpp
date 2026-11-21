#include "app/AppController.h"

#include <SD.h>

#include <algorithm>

#include "config/AppConfig.h"
#include "config/Pins.h"
#include "display/Screens.h"
#include "power/DeepSleep.h"
#include "power/PowerRail.h"
#include "util/Log.h"

namespace {
constexpr uint32_t kActionDelayMs = 400;   // let the HTTP reply flush first
constexpr uint32_t kReconnectIntervalMs = 30000;
constexpr uint32_t kReconnectTimeoutMs = 10000;

// Autonomy-test state kept in RTC memory so it survives deep sleep. A normal
// reset (button or power loss) stops the test because the wake cause is no
// longer the RTC alarm.
constexpr uint32_t kAutonomyMagic = 0x4155544F;  // "AUTO"
RTC_DATA_ATTR uint32_t gAutonomyMagic = 0;
RTC_DATA_ATTR uint32_t gAutonomyCycle = 0;
RTC_DATA_ATTR uint32_t gAutonomyImage = 0;
}  // namespace

AppController::AppController() : _web(*this) {}

AppController::~AppController() = default;

void AppController::begin() {
  LOG_I("=== %s %s ===", config::FirmwareName, config::FirmwareVersion);

  // Put every line that reaches a switched load into a safe state *before* the
  // rail comes up. A floating CS during the card's power ramp can make it enter
  // an undefined state, which shows up later as intermittent mount failures.
  pinMode(pins::SdCs, OUTPUT);
  digitalWrite(pins::SdCs, HIGH);
  pinMode(pins::EpdCs, OUTPUT);
  digitalWrite(pins::EpdCs, HIGH);
  pinMode(pins::SdSck, OUTPUT);
  digitalWrite(pins::SdSck, LOW);
  pinMode(pins::SdMosi, OUTPUT);
  digitalWrite(pins::SdMosi, LOW);

  // Everything below lives on the switched rail (or needs it), so power it up
  // before the display and the SD card are touched.
  power::begin();
  // The status LED marks "awake": light it as early as possible and let
  // power::deepSleep() put it out again.
  power::statusLedOn();

  // The card is mounted before the panel is initialised: the display driver
  // takes over VSPI and pulls in a large library, and keeping the two steps
  // apart makes it obvious which one breaks the card if it fails again.
  if (mountSd()) {
    _images.begin();
  }

  _display.begin();

  _settings.begin();
  _clock.begin();

  // The DS3231 alarm and the wake button pull the same INT line low; the
  // latched A1 flag, remembered by _clock.begin() before it cleared it,
  // tells the two apart.
  const bool wakeLine = power::wokeFromWakeLine();
  const bool alarmWake = wakeLine && _clock.alarmWasFired();
  if (wakeLine && !alarmWake) {
    LOG_I("App: forced wake-up via button");
  }
  if (alarmWake && gAutonomyMagic == kAutonomyMagic) {
    // Timer wake only swaps the image: this branch never returns to the
    // network code below, so the WiFi radio stays powered off for the cycle.
    LOG_I("Autonomy: resuming after RTC alarm (cycle %lu), WiFi stays off",
          (unsigned long)gAutonomyCycle);
    if (!runAutonomyCycle(false)) {
      LOG_E("Autonomy: cycle failed, returning to normal boot");
      gAutonomyMagic = 0;
    }
  }

  // Any non-alarm boot means the user reset or power-cycled the board.
  if (gAutonomyMagic == kAutonomyMagic) {
    LOG_W("Autonomy: test state discarded");
    gAutonomyMagic = 0;
  }

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

bool AppController::mountSd() {
  // Alternate between the normal clock and the slow one: an intermittent mount
  // failure is usually a power/state problem, and a clean power cycle plus a
  // re-init is the only thing that reliably resets the card controller.
  constexpr uint32_t kFrequencies[] = {
      config::SdMountFrequency,
      config::SdRetryFrequency,
      config::SdMountFrequency,
  };

  for (uint8_t attempt = 0; attempt < 3; ++attempt) {
    if (attempt > 0) {
      LOG_W("App: SD mount failed, power-cycling the rail (attempt %u)",
            (unsigned)attempt + 1);
      power::cycleRail();
    }
    if (_sd.begin(kFrequencies[attempt])) {
      return true;
    }
  }

  LOG_E("App: SD card unavailable after 3 attempts, image features disabled");
  return false;
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

void AppController::requestAutonomyTest() {
  _action = Action::AutonomyTest;
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

    case Action::AutonomyTest:
      startAutonomyTest();
      break;

    case Action::None:
      break;
  }
}

bool AppController::showImage(const String& name, bool persist) {
  if (!_sd.mounted()) {
    LOG_E("App: cannot show image, SD not mounted");
    return false;
  }
  File file = _images.open(name);
  if (!file) {
    LOG_E("App: failed to open image \"%s\"", name.c_str());
    return false;
  }

  LOG_I("App: rendering \"%s\" (%u bytes)", name.c_str(), (unsigned)file.size());
  _busy = true;
  const bool ok = _display.showRaw(file, file.size());
  _busy = false;
  file.close();

  if (!ok) {
    LOG_E("App: failed to render \"%s\"", name.c_str());
    return false;
  }

  _currentImage = name;
  if (persist) {
    _settings.setLastImage(name);
  }
  return true;
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

void AppController::startAutonomyTest() {
  if (!_clock.available()) {
    LOG_E("Autonomy: RTC unavailable, refusing to start");
    screens::Screen screen;
    screen.title = "Autonomy Error";
    screen.accent = GxEPD_RED;
    screen.lines.push_back("DS3231 RTC not found");
    screen.lines.push_back("Check SDA/SCL wiring");
    screen.footer = config::FirmwareVersion;
    screens::show(_display, screen);
    return;
  }

  LOG_I("Autonomy: test started");
  gAutonomyMagic = kAutonomyMagic;
  gAutonomyCycle = 0;
  gAutonomyImage = 0;

  if (!runAutonomyCycle(true)) {
    gAutonomyMagic = 0;
    LOG_E("Autonomy: test aborted");
  }
}

bool AppController::runAutonomyCycle(bool firstCycle) {
  ++gAutonomyCycle;
  LOG_I("Autonomy: cycle %lu starting", (unsigned long)gAutonomyCycle);

  // The alarm flag from the previous cycle latches the DS3231 INT line low.
  _clock.clearAlarm();

  bool rendered = false;
  if (_sd.mounted()) {
    std::vector<ImageEntry> items = _images.list();
    std::sort(items.begin(), items.end(),
              [](const ImageEntry& a, const ImageEntry& b) {
                return a.name < b.name;
              });

    if (!items.empty()) {
      const size_t index = gAutonomyImage % items.size();
      gAutonomyImage = (index + 1) % items.size();
      rendered = showImage(items[index].name, false);
    }
  }

  if (!rendered) {
    screens::Screen screen;
    screen.title = "Autonomy Test";
    screen.accent = GxEPD_YELLOW;
    screen.lines.push_back(String("Cycle ") + String(gAutonomyCycle));
    screen.lines.push_back("No image available on SD");
    screen.lines.push_back(String("Sleeping for ") +
                           String(config::AutonomyAlarmDelaySec) + " s");
    screen.footer = _clock.format("%Y-%m-%d %H:%M:%S");
    screens::show(_display, screen);
  }

  if (!_clock.setAlarmIn(config::AutonomyAlarmDelaySec)) {
    screens::Screen screen;
    screen.title = "Autonomy Error";
    screen.accent = GxEPD_RED;
    screen.lines.push_back("Could not arm RTC alarm");
    screen.lines.push_back("Check DS3231 wiring");
    screen.footer = _clock.format("%Y-%m-%d %H:%M:%S");
    screens::show(_display, screen);
    return false;
  }

  // The first cycle was started from the web UI: power the radio down before
  // sleeping. Later cycles never bring it up, so nothing to do there.
  if (firstCycle) {
    _network.shutdown();
  }

  LOG_I("Autonomy: cycle %lu done, sleeping until the RTC alarm",
        (unsigned long)gAutonomyCycle);
  // Shut the peripherals down cleanly, then let deepSleep() cut their rail.
  _display.shutdown();
  _sd.end();
  power::prepareRtcAlarmWake();
  power::deepSleep();
}
