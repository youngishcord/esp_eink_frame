#include <Arduino.h>

#include "app/AppController.h"
#include "util/Log.h"

AppController app;

void setup() {
  applog::begin(115200);
  delay(200);
  app.begin();
}

void loop() {
  app.loop();
  delay(2);
}
