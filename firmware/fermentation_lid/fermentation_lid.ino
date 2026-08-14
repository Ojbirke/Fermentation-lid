// Fermentation Lid — ESP32 firmware
//
// Measures the distance from the lid down to the surface of a sourdough starter
// with a VL53L1X time-of-flight sensor, and posts the readings to a server over
// WiFi. See docs/api.md for the HTTP contract this implements.
//
// Also prints a CSV log (minutes,mm) to Serial at 115200 baud, which is useful
// for debugging without a server. `-1` means the reading was invalid.
//
// Board:    "ESP32 Dev Module" in the Arduino IDE
// Library:  Pololu VL53L1X
// Wiring:   3.3V→VIN, GND→GND, GPIO21→SDA, GPIO22→SCL (I2C at 100 kHz, addr 0x29)

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <VL53L1X.h>
#include <time.h>

// ==== CONFIGURATION =========================================================
// Fill these in. Do not commit real credentials to a public repository.
const char* WIFI_SSID  = "YOUR_WIFI_SSID";        // ESP32 only sees 2.4 GHz networks
const char* WIFI_PASS  = "YOUR_WIFI_PASSWORD";
const char* SERVER_URL = "http://192.168.1.10:8090";  // your server; https:// also works
const char* LID_TOKEN  = "YOUR_LID_TOKEN";        // issued when the lid is provisioned
// ============================================================================

const uint32_t MEASURE_INTERVAL_S = 60;   // one reading per minute
const size_t   POST_EVERY = 1;            // upload after N readings (raise it to save power)
const char*    FW_VERSION = "lid-2.1";

const int PIN_SDA = 21;
const int PIN_SCL = 22;

// Recovery escalation, counted in consecutive failed measurement windows.
// At one reading a minute that is roughly 3 and 10 minutes.
const uint8_t FAILS_BEFORE_BUS_RECOVER = 3;
const uint8_t FAILS_BEFORE_RESTART     = 10;

VL53L1X sensor;

// Readings wait here until they have been accepted by the server, so a WiFi
// dropout does not punch a hole in the curve. 4 hours at one per minute.
struct Sample { uint32_t ts; int16_t mm; };
const size_t BUF_CAP = 240;
Sample buf[BUF_CAP];
size_t bufLen = 0;

// --- Sensor and recovery -----------------------------------------------------

// Returns whether the sensor came up. This MUST be bounded: an unbounded retry
// loop here hangs the whole firmware, and then the lid stops reporting entirely
// rather than reporting that it is blind. (That bug cost a night of data.)
bool initSensor(uint8_t tries = 3) {
  for (uint8_t i = 0; i < tries; i++) {
    sensor.setTimeout(500);
    if (sensor.init()) {
      sensor.setDistanceMode(VL53L1X::Long);
      sensor.setMeasurementTimingBudget(50000);
      sensor.startContinuous(100);
      return true;
    }
    Serial.print("# sensor init failed ("); Serial.print(i + 1); Serial.println(")");
    delay(200);
  }
  return false;
}

// Frees the bus when a slave is holding SDA low: clock out up to 9 bits by hand
// and finish with a STOP. This is the only way to clear a wedged I2C bus without
// power-cycling the sensor.
void i2cBusRecover() {
  Serial.println("# i2c: attempting bus recovery");
  Wire.end();
  pinMode(PIN_SDA, INPUT_PULLUP);
  pinMode(PIN_SCL, OUTPUT);
  for (int i = 0; i < 9; i++) {
    digitalWrite(PIN_SCL, LOW);  delayMicroseconds(5);
    digitalWrite(PIN_SCL, HIGH); delayMicroseconds(5);
    if (digitalRead(PIN_SDA) == HIGH) break;   // the slave let go
  }
  // STOP condition: SDA low -> SCL high -> SDA high
  pinMode(PIN_SDA, OUTPUT);
  digitalWrite(PIN_SDA, LOW);  delayMicroseconds(5);
  digitalWrite(PIN_SCL, HIGH); delayMicroseconds(5);
  digitalWrite(PIN_SDA, HIGH); delayMicroseconds(5);

  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(100000);
}

// Median of n readings, or -1 if none were valid. Raw noise is around ±3 mm, and
// a median also throws away the occasional wild single reading. Does no recovery
// itself — escalation lives in loop() so it can never block the measuring cycle.
int readMedian(int n) {
  int v[15], c = 0;
  for (int i = 0; i < n; i++) {
    int mm = sensor.read();
    if (!sensor.timeoutOccurred() && mm > 0) v[c++] = mm;
    delay(30);
  }
  if (c == 0) return -1;
  for (int i = 0; i < c - 1; i++)
    for (int j = i + 1; j < c; j++)
      if (v[j] < v[i]) { int t = v[i]; v[i] = v[j]; v[j] = t; }
  return v[c / 2];
}

// --- WiFi and clock ---------------------------------------------------------

bool wifiEnsure() {
  if (WiFi.status() == WL_CONNECTED) return true;
  Serial.println("# wifi: connecting...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(500);
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("# wifi: ok, ip="); Serial.println(WiFi.localIP());
    return true;
  }
  Serial.println("# wifi: failed (readings will be buffered)");
  return false;
}

bool timeSynced() { return time(nullptr) > 1700000000; }

// Readings are timestamped on the device, so NTP has to succeed at least once.
// The internal clock keeps running afterwards, including through WiFi outages.
void ntpEnsure() {
  if (timeSynced()) return;
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  for (int i = 0; i < 30 && !timeSynced(); i++) delay(500);
  if (timeSynced()) Serial.println("# ntp: ok");
}

// --- Upload -----------------------------------------------------------------

bool postBatch() {
  if (bufLen == 0) return true;
  if (!wifiEnsure()) return false;

  size_t n = bufLen < 100 ? bufLen : 100;   // the API accepts up to 500 per request
  String body = "{\"firmwareVersion\":\"";
  body += FW_VERSION;
  body += "\",\"samples\":[";
  for (size_t i = 0; i < n; i++) {
    if (i) body += ",";
    body += "{\"ts\":";
    body += String(buf[i].ts);
    body += ",\"distanceMm\":";
    body += String(buf[i].mm);
    body += "}";
  }
  body += "]}";

  String url = String(SERVER_URL) + "/api/lid/measurements";
  bool useTls = url.startsWith("https");
  WiFiClientSecure secureClient;
  WiFiClient plainClient;
  if (useTls) secureClient.setInsecure();   // no certificate pinning in this version

  HTTPClient http;
  bool ok = useTls ? http.begin(secureClient, url) : http.begin(plainClient, url);
  if (!ok) { Serial.println("# http.begin failed"); return false; }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-lid-token", LID_TOKEN);
  http.setTimeout(10000);
  int code = http.POST(body);
  http.end();

  if (code == 200) {
    memmove(buf, buf + n, (bufLen - n) * sizeof(Sample));
    bufLen -= n;
    Serial.print("# sent "); Serial.print(n);
    Serial.print(" readings, buffered="); Serial.println(bufLen);
    return true;
  }
  // Re-sending is safe: the server ignores samples it already has (same lid and
  // timestamp), so keep everything and try again next time round.
  Serial.print("# post failed, code="); Serial.print(code);
  Serial.print(", buffered="); Serial.println(bufLen);
  return false;
}

// --- Main loop --------------------------------------------------------------

unsigned long lastMeasure = 0;
uint8_t consecutiveFails = 0;

void setup() {
  Serial.begin(115200);
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(100000);
  if (!initSensor()) {
    Serial.println("# sensor silent at boot - trying bus recovery");
    i2cBusRecover();
    initSensor();   // if this fails too, loop() escalation takes over
  }
  wifiEnsure();
  ntpEnsure();
  Serial.println("min,mm");   // CSV header for the Serial log
}

void loop() {
  if (millis() - lastMeasure >= MEASURE_INTERVAL_S * 1000UL) {
    lastMeasure = millis();

    int mm = readMedian(7);
    Serial.print(millis() / 60000.0, 1); Serial.print(","); Serial.println(mm);

    // Escalating recovery. The -1 is still buffered and sent, so the server can
    // see that the lid is alive but blind — that is useful information, and far
    // better than the lid going silent.
    if (mm < 0) {
      consecutiveFails++;
      if (consecutiveFails == FAILS_BEFORE_BUS_RECOVER) {
        i2cBusRecover();
        initSensor();
      } else if (consecutiveFails >= FAILS_BEFORE_RESTART) {
        Serial.println("# sensor unrecoverable - restarting the board");
        postBatch();          // flush what we have before rebooting
        delay(500);
        ESP.restart();
      }
    } else {
      consecutiveFails = 0;
    }

    if (!timeSynced()) ntpEnsure();   // in case NTP never succeeded at boot
    if (timeSynced()) {
      if (bufLen == BUF_CAP) { memmove(buf, buf + 1, (BUF_CAP - 1) * sizeof(Sample)); bufLen--; }
      buf[bufLen].ts = (uint32_t)time(nullptr);
      buf[bufLen].mm = (int16_t)mm;
      bufLen++;
    }

    if (bufLen >= POST_EVERY) postBatch();
  }
}
