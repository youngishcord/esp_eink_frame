#include "web/WebServerApp.h"

#include <SD.h>

#include "app/AppController.h"
#include "config/AppConfig.h"
#include "util/Log.h"
#include "web/WebAssets.generated.h"

namespace {
constexpr char kJsonType[] = "application/json";
}  // namespace

WebServerApp::WebServerApp(AppController& app) : _app(app), _server(80) {}

void WebServerApp::begin() {
  registerRoutes();
  _server.begin();
  LOG_I("Web: server listening on port 80");
}

void WebServerApp::registerRoutes() {
  _server.on("/", HTTP_GET, [this]() { handleIndex(); });
  _server.on("/app.css", HTTP_GET, [this]() { handleCss(); });
  _server.on("/app.js", HTTP_GET, [this]() { handleJs(); });

  _server.on("/api/status", HTTP_GET, [this]() { handleStatus(); });
  _server.on("/api/images", HTTP_GET, [this]() { handleListImages(); });
  _server.on("/api/file", HTTP_GET, [this]() { handleGetImage(); });
  _server.on("/api/images/delete", HTTP_POST, [this]() { handleDeleteImage(); });

  _server.on("/api/images/upload", HTTP_POST,
             [this]() { handleUploadComplete(); },
             [this]() { handleUploadData(); });

  _server.on("/api/display", HTTP_POST, [this]() { handleShowImage(); });
  _server.on("/api/wifi", HTTP_POST, [this]() { handleWifiSave(); });
  _server.on("/api/wifi/reset", HTTP_POST, [this]() { handleWifiReset(); });
  _server.on("/api/status-screen", HTTP_POST, [this]() { handleStatusScreen(); });

  _server.onNotFound([this]() { handleNotFound(); });
}

void WebServerApp::loop() {
  _server.handleClient();
}

void WebServerApp::sendJson(int code, const String& body) {
  _server.send(code, kJsonType, body);
}

void WebServerApp::handleIndex() {
  _server.send_P(200, "text/html; charset=utf-8", kIndexHtml);
}

void WebServerApp::handleCss() {
  _server.send_P(200, "text/css; charset=utf-8", kAppCss);
}

void WebServerApp::handleJs() {
  _server.send_P(200, "application/javascript; charset=utf-8", kAppJs);
}

void WebServerApp::handleStatus() {
  NetworkManager& net = _app.network();
  String json = "{";
  json += "\"firmware\":\"" + String(config::FirmwareName) + "\",";
  json += "\"version\":\"" + String(config::FirmwareVersion) + "\",";
  json += "\"apMode\":" + String(net.apActive() ? "true" : "false") + ",";
  json += "\"connected\":" + String(net.stationConnected() ? "true" : "false") + ",";
  json += "\"ssid\":\"" + net.stationSsid() + "\",";
  json += "\"ip\":\"" + net.stationIp() + "\",";
  json += "\"apSsid\":\"" + net.apSsid() + "\",";
  json += "\"apIp\":\"" + net.apIp() + "\",";
  json += "\"sd\":" + String(_app.sdMounted() ? "true" : "false") + ",";
  json += "\"image\":\"" + _app.currentImage() + "\"";
  json += "}";
  sendJson(200, json);
}

void WebServerApp::handleListImages() {
  const std::vector<ImageEntry> items = _app.images().list();
  String json = "[";
  for (size_t i = 0; i < items.size(); ++i) {
    if (i > 0) {
      json += ",";
    }
    json += "{\"name\":\"" + items[i].name + "\",\"size\":" +
            String(items[i].size) + "}";
  }
  json += "]";
  sendJson(200, json);
}

void WebServerApp::handleGetImage() {
  const String name = _app.images().sanitize(_server.arg("name"));
  if (name.isEmpty() || !_app.images().exists(name)) {
    _server.send(404, "text/plain", "not found");
    return;
  }
  File file = _app.images().open(name);
  if (!file) {
    _server.send(500, "text/plain", "open failed");
    return;
  }
  _server.streamFile(file, "application/octet-stream");
  file.close();
}

void WebServerApp::handleDeleteImage() {
  const String name = _app.images().sanitize(_server.arg("name"));
  if (name.isEmpty() || !_app.images().exists(name)) {
    sendJson(404, "{\"ok\":false,\"error\":\"not found\"}");
    return;
  }
  const bool removed = _app.images().remove(name);
  sendJson(removed ? 200 : 500,
           removed ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"delete failed\"}");
}

void WebServerApp::handleUploadData() {
  HTTPUpload& upload = _server.upload();

  if (upload.status == UPLOAD_FILE_START) {
    _uploadName = ImageRepository::sanitize(upload.filename);
    if (_uploadName.isEmpty()) {
      _uploadName = "image";
    }
    if (_uploadFile) {
      _uploadFile.close();
    }
    _uploadFile =
        SD.open(ImageRepository::pathFor(_uploadName), FILE_WRITE);
    LOG_I("Web: upload started -> %s", _uploadName.c_str());
  } else if (upload.status == UPLOAD_FILE_WRITE) {
    if (_uploadFile) {
      _uploadFile.write(upload.buf, upload.currentSize);
    }
  } else if (upload.status == UPLOAD_FILE_END) {
    if (_uploadFile) {
      _uploadFile.close();
    }
  } else if (upload.status == UPLOAD_FILE_ABORTED) {
    if (_uploadFile) {
      _uploadFile.close();
    }
    SD.remove(ImageRepository::pathFor(_uploadName));
    LOG_W("Web: upload aborted");
  }
}

void WebServerApp::handleUploadComplete() {
  const String path = ImageRepository::pathFor(_uploadName);
  File file = SD.open(path, FILE_READ);
  const size_t size = file ? file.size() : 0;
  if (file) {
    file.close();
  }

  if (size != config::FrameBytes) {
    SD.remove(path);
    LOG_W("Web: rejected upload \"%s\" (%u bytes)", _uploadName.c_str(),
          (unsigned)size);
    sendJson(400, "{\"ok\":false,\"error\":\"unexpected frame size\"}");
    return;
  }

  LOG_I("Web: stored \"%s\" (%u bytes)", _uploadName.c_str(), (unsigned)size);
  sendJson(200, "{\"ok\":true,\"name\":\"" + _uploadName + "\"}");
}

void WebServerApp::handleShowImage() {
  const String name = _app.images().sanitize(_server.arg("name"));
  if (name.isEmpty() || !_app.images().exists(name)) {
    sendJson(404, "{\"ok\":false,\"error\":\"not found\"}");
    return;
  }
  _app.requestShowImage(name);
  sendJson(200, "{\"ok\":true}");
}

void WebServerApp::handleWifiSave() {
  const String ssid = _server.arg("ssid");
  const String password = _server.arg("password");
  if (ssid.isEmpty()) {
    sendJson(400, "{\"ok\":false,\"error\":\"ssid required\"}");
    return;
  }
  _app.requestWifiChange(ssid, password);
  sendJson(200, "{\"ok\":true}");
}

void WebServerApp::handleWifiReset() {
  _app.requestWifiReset();
  sendJson(200, "{\"ok\":true}");
}

void WebServerApp::handleStatusScreen() {
  _app.requestStatusScreen();
  sendJson(200, "{\"ok\":true}");
}

void WebServerApp::handleNotFound() {
  if (_server.method() == HTTP_OPTIONS) {
    _server.send(204);
    return;
  }
  _server.send(404, "text/plain", "not found");
}
