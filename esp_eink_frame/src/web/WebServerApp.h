#pragma once

#include <Arduino.h>
#include <FS.h>
#include <WebServer.h>

// HTTP server exposing the SPA and a small JSON API. Handlers only validate and
// delegate: anything that can block for a long time is queued on the
// AppController.

class AppController;

class WebServerApp {
 public:
  explicit WebServerApp(AppController& app);

  void begin();
  void loop();

 private:
  void registerRoutes();

  void handleIndex();
  void handleCss();
  void handleJs();
  void handleStatus();
  void handleListImages();
  void handleGetImage();
  void handleDeleteImage();
  void handleUploadComplete();
  void handleUploadData();
  void handleShowImage();
  void handleWifiSave();
  void handleWifiReset();
  void handleStatusScreen();
  void handleNotFound();

  void sendJson(int code, const String& body);

  AppController& _app;
  WebServer _server;
  File _uploadFile;
  String _uploadName;
};
