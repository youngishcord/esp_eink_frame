#include "net/NetworkManager.h"

#include "config/AppConfig.h"
#include "util/Log.h"

namespace {

String buildApSsid() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char suffix[5];
  snprintf(suffix, sizeof(suffix), "%02X%02X", mac[4], mac[5]);
  return String(config::ApSsidPrefix) + "-" + suffix;
}

}  // namespace

void NetworkManager::begin() {
  _apSsid = buildApSsid();
  WiFi.persistent(false);
  WiFi.setAutoReconnect(false);
  WiFi.mode(WIFI_STA);
  LOG_I("Net: AP SSID will be \"%s\"", _apSsid.c_str());
}

bool NetworkManager::connect(const String& ssid, const String& password,
                             uint32_t timeoutMs) {
  if (ssid.isEmpty()) {
    return false;
  }

  // Switch from the provisioning AP to station mode without powering the radio
  // off: turning WiFi off here makes the core call esp_wifi_deinit(), and the
  // re-init leaves the STA netif without a driver so DHCP never finishes.
  stopAp();
  WiFi.mode(WIFI_STA);
  delay(100);
  WiFi.begin(ssid.c_str(), password.c_str());
  LOG_I("Net: connecting to \"%s\" ...", ssid.c_str());

  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    delay(100);
  }

  if (WiFi.status() != WL_CONNECTED) {
    LOG_W("Net: connection to \"%s\" failed", ssid.c_str());
    return false;
  }

  LOG_I("Net: connected, IP %s", stationIp().c_str());
  return true;
}

void NetworkManager::startAp() {
  WiFi.mode(WIFI_AP);
  const bool ok = WiFi.softAP(_apSsid.c_str(), config::ApPassword);
  LOG_I("Net: SoftAP %s (password \"%s\")", ok ? "started" : "failed",
        config::ApPassword);
}

void NetworkManager::stopAp() {
  if (WiFi.getMode() & WIFI_AP) {
    // wifioff=false: clear the AP config but keep the radio up (no deinit).
    WiFi.softAPdisconnect(false);
  }
}

void NetworkManager::disconnectStation() {
  // wifioff=false: drop the association but keep the radio up (no deinit).
  WiFi.disconnect(false, false);
}

bool NetworkManager::stationConnected() const {
  return WiFi.status() == WL_CONNECTED;
}

bool NetworkManager::apActive() const {
  return (WiFi.getMode() & WIFI_AP) != 0;
}

String NetworkManager::stationSsid() const {
  return WiFi.SSID();
}

String NetworkManager::stationIp() const {
  return WiFi.localIP().toString();
}

String NetworkManager::apSsid() const {
  return _apSsid;
}

const char* NetworkManager::apPassword() const {
  return config::ApPassword;
}

String NetworkManager::apIp() const {
  return WiFi.softAPIP().toString();
}
