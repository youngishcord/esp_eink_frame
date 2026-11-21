#pragma once

#include <stddef.h>
#include <stdint.h>

// Compile-time application configuration. Nothing here should require runtime
// computation; runtime settings (WiFi credentials, last image, ...) live in the
// NVS-backed SettingsStore.

namespace config {

constexpr char FirmwareName[] = "esp_eink_frame";
constexpr char FirmwareVersion[] = "0.2.0";

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
// Clock used for the first SD mount attempt. 4 MHz is the value the card was
// proven to mount at in the standalone test; faster clocks are only worth
// chasing once mounting is reliable.
constexpr uint32_t SdMountFrequency = 4000000;
// Slower clock used for the retry after the rail has been power-cycled.
constexpr uint32_t SdRetryFrequency = 400000;

// --- Wireless provisioning ---
constexpr char ApSsidPrefix[] = "eink-frame";
// SoftAP passwords must be at least 8 characters.
constexpr char ApPassword[] = "einkframe";
constexpr char ApDefaultIp[] = "192.168.4.1";
constexpr uint32_t StaConnectTimeoutMs = 20000;
constexpr uint32_t NtpSyncIntervalMs = 6UL * 60UL * 60UL * 1000UL;

// --- Power rail ---
// Time the switched SD/e-Paper rail is given to charge its capacitors and for
// the microSD card to finish its internal power-on sequence. The SD physical
// layer wants ~250 ms from VCC ramp to the first command; a card that is
// initialised too early answers the init commands and then fails the first
// sector read ("token error 0x4" / FR_DISK_ERR). Only paid once per boot.
constexpr uint32_t PowerRailSettleMs = 300;

// Level on pins::PowerGate that powers the rail.
//   false -> LOW powers it (P-channel MOSFET, PNP transistor, or the 100 kOhm
//            pull-up default of the current board)
//   true  -> HIGH powers it (a ready-made module with an active-high enable
//            input)
constexpr bool PowerGateActiveHigh = false;

// --- Autonomy test ---
// Every wake renders the next SD image, sets the DS3231 alarm for this many
// seconds ahead and goes back to deep sleep.
constexpr uint32_t AutonomyAlarmDelaySec = 60;

// --- Storage ---
constexpr char ImagesDirectory[] = "/images";
constexpr char ImageExtension[] = ".e6";
constexpr size_t MaxImageNameLength = 40;
// Display titles live in the sidecar table, not in the file name, so they are
// only limited by what the web UI can show. Measured in UTF-8 bytes.
constexpr size_t MaxImageTitleLength = 80;

}  // namespace config
