#pragma once

#include <Arduino.h>
#include <WiFi.h>

// Owns the radio. Two mutually exclusive roles are supported: a station that
// joins the user's network, and a SoftAP used for first-time provisioning.
//
// The class is intentionally synchronous: connect() blocks up to `timeoutMs`.
// Callers run it from the main loop where a brief block is acceptable, and it
// keeps the state machine easy to reason about.

class NetworkManager {
 public:
  void begin();

  // Joins a network, blocking up to timeoutMs. On failure the radio is left in
  // station mode (disconnected) so callers can decide whether to start the AP.
  bool connect(const String& ssid, const String& password,
               uint32_t timeoutMs);

  // Brings up the provisioning SoftAP.
  void startAp();
  void stopAp();

  void disconnectStation();

  bool stationConnected() const;
  bool apActive() const;

  String stationSsid() const;
  String stationIp() const;
  String apSsid() const;
  const char* apPassword() const;
  String apIp() const;

 private:
  String _apSsid;
};
