#pragma once

#include <stddef.h>
#include <stdint.h>

// Compile-time application configuration. Nothing here should require runtime
// computation; runtime settings (WiFi credentials, last image, ...) live in the
// NVS-backed SettingsStore.

namespace config {

constexpr char FirmwareName[] = "esp_eink_frame";
constexpr char FirmwareVersion[] = "0.1.0";

// --- Display (Waveshare 7.3" e-Paper (E), E Ink Spectra 6, GDEP073E01) ---
constexpr int DisplayWidth = 800;
constexpr int DisplayHeight = 480;
// Two 4-bit pixels per byte, high nibble = left pixel.
constexpr size_t FrameBytes =
    static_cast<size_t>(DisplayWidth) * DisplayHeight / 2;
// The panel is driven page-by-page (GxEPD2) to keep RAM use small. One page is
// EpdPageHeight rows; use a value that divides DisplayHeight evenly (480/120=4).
constexpr uint16_t EpdPageHeight = 120;

// --- SPI ---
constexpr uint32_t EpdSpiFrequency = 8000000;
constexpr uint32_t SdSpiFrequency = 10000000;

// --- Wireless provisioning ---
constexpr char ApSsidPrefix[] = "eink-frame";
// SoftAP passwords must be at least 8 characters.
constexpr char ApPassword[] = "einkframe";
constexpr char ApDefaultIp[] = "192.168.4.1";
constexpr uint32_t StaConnectTimeoutMs = 20000;
constexpr uint32_t NtpSyncIntervalMs = 6UL * 60UL * 60UL * 1000UL;

// --- Storage ---
constexpr char ImagesDirectory[] = "/images";
constexpr char ImageExtension[] = ".e6";
constexpr size_t MaxImageNameLength = 40;

}  // namespace config
