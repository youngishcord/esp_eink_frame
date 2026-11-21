#pragma once

// Switched 3.3 V rail shared by the microSD card and the e-Paper HAT.
//
// A single P-channel MOSFET gates both loads. Its gate is pulled up to 3.3 V by
// a resistor, so the hardware default after reset or while the pin floats in
// deep sleep is *off*:
//
//   GPIO low  -> gate pulled low -> rail powered
//   GPIO high -> gate at 3.3 V   -> rail cut
//
// Cutting the rail also resets both peripherals: the display and the card must
// go through begin() again after the rail comes back.

namespace power {

// Releases the hold left by the previous deep sleep, powers the rail and waits
// for it to settle. Call first thing in AppController::begin(), before the
// display or the SD card are touched.
void begin();

// Cuts the rail. Every signal line that reaches an unpowered load must already
// be parked at 0 V, otherwise it back-powers the load through its ESD diodes.
// Used by deepSleep(); regular code should call begin() instead.
void railOff();

// Cuts the rail, waits for the loads to discharge and powers it again. A card
// that answered on the bus but failed its first sector read is often left in a
// stuck state; a real power cycle is the only way to reset it. Callers must
// re-initialise everything that lives on the rail afterwards.
void cycleRail();

}  // namespace power
