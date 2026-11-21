// Standalone SD bring-up probe (PlatformIO env `sd_probe`).
//
// It runs the same sequence as the sketch that is known to work on this
// hardware and then dumps the raw SPI conversation, so a mount failure can be
// attributed either to the card/power rail (hardware) or to the application.
//
//   pio run -e sd_probe -t upload
//   pio device monitor
//
// This file is excluded from the normal firmware build.

#include <Arduino.h>
#include <SD.h>
#include <SPI.h>

namespace {

constexpr int kSdSck = 14;
constexpr int kSdMosi = 13;
constexpr int kSdMiso = 27;
constexpr int kSdCs = 5;
constexpr int kPowerGate = 4;

constexpr uint32_t kMountFrequency = 4000000;
constexpr uint32_t kRailSettleMs = 300;

SPIClass spiSD(HSPI);

// CRC7 over the five command bytes, then the end bit (same as the SD library).
uint8_t crc7(const uint8_t* data, size_t length) {
  uint8_t crc = 0;
  for (size_t i = 0; i < length; i++) {
    uint8_t d = data[i];
    for (int b = 0; b < 8; b++) {
      crc <<= 1;
      if ((d & 0x80) ^ (crc & 0x80)) {
        crc ^= 0x09;
      }
      d <<= 1;
    }
  }
  return static_cast<uint8_t>((crc << 1) | 0x01);
}

// Asserts CS, sends one command and returns R1. CS stays asserted so the caller
// can read R3/R7 payloads or the data block, and must call endCommand().
uint8_t startCommand(uint8_t cmd, uint32_t arg) {
  uint8_t packet[5] = {
      static_cast<uint8_t>(0x40 | cmd),
      static_cast<uint8_t>(arg >> 24),
      static_cast<uint8_t>(arg >> 16),
      static_cast<uint8_t>(arg >> 8),
      static_cast<uint8_t>(arg),
  };

  digitalWrite(kSdCs, LOW);
  spiSD.transfer(0xFF);
  spiSD.writeBytes(packet, sizeof(packet));
  spiSD.transfer(crc7(packet, sizeof(packet)));

  uint8_t r1 = 0xFF;
  for (int i = 0; i < 10 && (r1 & 0x80); i++) {
    r1 = spiSD.transfer(0xFF);
  }
  return r1;
}

void endCommand() {
  digitalWrite(kSdCs, HIGH);
  spiSD.transfer(0xFF);
}

uint32_t readU32() {
  uint32_t value = 0;
  for (int i = 0; i < 4; i++) {
    value = (value << 8) | spiSD.transfer(0xFF);
  }
  return value;
}

bool waitDataToken(const char* what) {
  const uint32_t start = millis();
  while (millis() - start < 500) {
    const uint8_t b = spiSD.transfer(0xFF);
    if (b == 0xFE) {
      return true;
    }
    if (b != 0xFF && !(b & 0x80)) {
      Serial.printf("       %s: data error token 0x%02X\n", what, b);
      return false;
    }
  }
  Serial.printf("       %s: no data token within 500 ms\n", what);
  return false;
}

void dumpRawBus() {
  Serial.println();
  Serial.println("=== raw SPI conversation @ 400 kHz ===");

  spiSD.beginTransaction(SPISettings(400000, MSBFIRST, SPI_MODE0));

  // 80 clocks with CS high: the card needs them to finish its power-up.
  digitalWrite(kSdCs, HIGH);
  for (int i = 0; i < 10; i++) {
    spiSD.transfer(0xFF);
  }

  uint8_t r1 = startCommand(0, 0);
  endCommand();
  Serial.printf("CMD0  GO_IDLE_STATE     -> 0x%02X (expect 0x01)\n", r1);
  if (r1 != 0x01) {
    Serial.println("       card does not answer in SPI mode: power, CS or MISO");
    spiSD.endTransaction();
    return;
  }

  r1 = startCommand(8, 0x000001AA);
  const uint32_t r7 = readU32();
  endCommand();
  Serial.printf("CMD8  SEND_IF_COND      -> 0x%02X, R7=0x%08X (expect 0x1AA)\n", r1,
                r7);

  const uint32_t start = millis();
  uint8_t acmd41 = 0xFF;
  do {
    startCommand(55, 0);
    endCommand();
    acmd41 = startCommand(41, 0x40000000);
    endCommand();
  } while (acmd41 != 0x00 && millis() - start < 2000);
  Serial.printf("ACMD41 APP_SEND_OP_COND -> 0x%02X after %lu ms (expect 0x00)\n",
                acmd41, (unsigned long)(millis() - start));

  r1 = startCommand(58, 0);
  const uint32_t ocr = readU32();
  endCommand();
  Serial.printf("CMD58 READ_OCR          -> 0x%02X, OCR=0x%08X (%s)\n", r1, ocr,
                (ocr & (1UL << 30)) ? "SDHC/block addressed" : "SDSC/byte addressed");

  r1 = startCommand(9, 0);
  Serial.printf("CMD9  SEND_CSD          -> 0x%02X\n", r1);
  if (r1 == 0x00 && waitDataToken("CSD")) {
    uint8_t csd[16];
    for (int i = 0; i < 16; i++) {
      csd[i] = spiSD.transfer(0xFF);
    }
    spiSD.transfer(0xFF);  // CRC
    spiSD.transfer(0xFF);
    Serial.printf("       CSD %02X %02X %02X %02X ...\n", csd[0], csd[1], csd[2],
                  csd[3]);
  }
  endCommand();

  static uint8_t sector[512];
  r1 = startCommand(17, 0);
  Serial.printf("CMD17 READ_SINGLE_BLOCK -> 0x%02X (expect 0x00)\n", r1);
  if (r1 == 0x00 && waitDataToken("sector 0")) {
    for (int i = 0; i < 512; i++) {
      sector[i] = spiSD.transfer(0xFF);
    }
    spiSD.transfer(0xFF);  // CRC
    spiSD.transfer(0xFF);
    Serial.printf("       sector 0: %02X %02X %02X %02X | %02X %02X %02X %02X ...\n",
                  sector[0], sector[1], sector[2], sector[3], sector[4],
                  sector[5], sector[6], sector[7]);
    Serial.printf("       bytes 510/511 = 0x%02X 0x%02X -> %s\n", sector[510],
                  sector[511],
                  (sector[510] == 0x55 && sector[511] == 0xAA) ? "MBR present"
                                                               : "no MBR");
  }
  endCommand();

  spiSD.endTransaction();
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(1500);  // give the monitor time to attach

  Serial.println();
  Serial.println("=== SD bring-up probe ===");

  // Power the switched rail exactly like the firmware does.
  pinMode(kPowerGate, OUTPUT);
  digitalWrite(kPowerGate, LOW);
  delay(kRailSettleMs);
  Serial.printf("Rail: gate GPIO%d driven LOW, reads %d\n", kPowerGate,
                digitalRead(kPowerGate));

  pinMode(kSdMiso, INPUT);
  Serial.printf("MISO GPIO%d idle before SPI attach: %d\n", kSdMiso,
                digitalRead(kSdMiso));

  spiSD.begin(kSdSck, kSdMiso, kSdMosi, kSdCs);
  digitalWrite(kSdCs, HIGH);
  for (int i = 0; i < 8; i++) {
    spiSD.transfer(0xFF);
  }
  Serial.printf("MISO GPIO%d after 8 clocks, CS high: %d (expect 1)\n", kSdMiso,
                digitalRead(kSdMiso));

  // 1) The exact sequence of the working standalone sketch.
  Serial.println();
  Serial.printf("SD.begin(cs=%d, HSPI, %u Hz) ...\n", kSdCs,
                (unsigned)kMountFrequency);
  if (SD.begin(kSdCs, spiSD, kMountFrequency)) {
    Serial.println("RESULT: mounted");
    Serial.printf("        type=%u, size=%llu MB\n", (unsigned)SD.cardType(),
                  SD.cardSize() / (1024ULL * 1024ULL));
    File file = SD.open("/probe.txt", FILE_WRITE);
    if (file) {
      file.println("probe ok");
      file.close();
      Serial.println("        write /probe.txt: OK");
    } else {
      Serial.println("        write /probe.txt: FAILED");
    }
    SD.end();
  } else {
    Serial.println("RESULT: mount failed");
  }

  // 2) Raw bus conversation, independent of the library state.
  dumpRawBus();

  Serial.println();
  Serial.println("How to read this:");
  Serial.println("  CMD0 -> 0xFF ................ card silent: power, CS or MISO");
  Serial.println("  CMD0 -> 0x01, data read fails power brownout during the burst");
  Serial.println("  all 0x00 + MBR present ...... card and rail fine, look at the app");
  Serial.println("Done.");
}

void loop() {}
