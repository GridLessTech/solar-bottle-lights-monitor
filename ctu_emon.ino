#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <Adafruit_INA219.h>

#define RELAY1 16
#define RELAY2 17
#define RELAY3 18
#define RELAY4 19
#define BUTTON1 32
#define BUTTON2 33
#define BUTTON3 27
#define BUTTON4 26

#define RELAY_ON LOW
#define RELAY_OFF HIGH
#define BUTTON_PRESSED LOW
#define BUTTON_RELEASED HIGH

const char* WIFI_SSID = "ADMIN";
const char* WIFI_PASSWORD = "admin54321";
const char* MQTT_HOST = "mqtt-racknerd.imbento.online";
const uint16_t MQTT_PORT = 1883;
const char* MQTT_USERNAME = "roche";
const char* MQTT_PASSWORD = "roche@54321";
const char* DEVICE_ID = "ctu-electric-monitor";

const unsigned long STEP_INTERVAL = 1000;
const unsigned long INA219_INTERVAL = 1000;
const unsigned long MQTT_RETRY_INTERVAL = 5000;
const unsigned long STATUS_INTERVAL = 3000;
const unsigned long WIFI_RETRY_INTERVAL = 10000;
const unsigned long BUTTON_DEBOUNCE_MS = 60;
const unsigned long BUTTON_STARTUP_IGNORE_MS = 2000;

unsigned long lastStepTime = 0;
unsigned long lastIna219ReadTime = 0;
unsigned long lastMqttRetryTime = 0;
unsigned long lastStatusPublishTime = 0;
unsigned long lastWiFiAttemptTime = 0;
unsigned long telemetrySequence = 0;
unsigned long buttonReadyTime = 0;
int stepIndex = 0;
float totalEnergyWh = 0.0f;

const int relays[4] = {RELAY1, RELAY2, RELAY3, RELAY4};
const int buttons[4] = {BUTTON1, BUTTON2, BUTTON3, BUTTON4};
bool relayStates[4] = {false, false, false, false};
int lastButtonReading[4] = {BUTTON_RELEASED, BUTTON_RELEASED, BUTTON_RELEASED, BUTTON_RELEASED};
int stableButtonState[4] = {BUTTON_RELEASED, BUTTON_RELEASED, BUTTON_RELEASED, BUTTON_RELEASED};
unsigned long lastButtonChangeTime[4] = {0, 0, 0, 0};

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);
Adafruit_INA219 ina219;
bool ina219Ready = false;
TaskHandle_t wifiTaskHandle = nullptr;

const char* TOPIC_STATUS = "/ctu/electric-monitor/status";
const char* TOPIC_TELEMETRY = "/ctu/electric-monitor/telemetry";
const char* TOPIC_RELAY_STATE_PREFIX = "/ctu/electric-monitor/relay/";
const char* TOPIC_RELAY_COMMAND_SUFFIX = "/set";
const char* TOPIC_RELAY_STATE_SUFFIX = "/state";

#define TOTAL_STEPS 8

void startWiFiConnection();
void ensureMqttConnection();
void mqttCallback(char* topic, byte* payload, unsigned int length);
void subscribeTopics();
void handleRelaySequence();
void handlePushButtons();
void setRelayState(uint8_t relayIndex, bool turnOn, bool publishState);
void publishRelayState(uint8_t relayIndex);
void publishAllRelayStates();
void readIna219ToSerialAndMqtt();
void publishOnlineStatus();
void publishOfflineStatus();
void wifiConnectionTask(void* parameter);

void setup() {
  for (int i = 0; i < 4; i++) {
    digitalWrite(relays[i], RELAY_OFF);
    pinMode(relays[i], OUTPUT);
    pinMode(buttons[i], INPUT_PULLUP);
    lastButtonReading[i] = digitalRead(buttons[i]);
    stableButtonState[i] = lastButtonReading[i];
    lastButtonChangeTime[i] = millis();
  }

  Serial.begin(115200);
  Wire.begin();

  ina219Ready = ina219.begin();
  if (ina219Ready) {
    Serial.println("INA219 initialized.");
  } else {
    Serial.println("INA219 not detected. Check wiring and I2C address.");
  }

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);

  buttonReadyTime = millis() + BUTTON_STARTUP_IGNORE_MS;
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  startWiFiConnection();
  xTaskCreatePinnedToCore(
    wifiConnectionTask,
    "wifiConnectionTask",
    4096,
    nullptr,
    1,
    &wifiTaskHandle,
    0
  );
  Serial.println("System boot complete.");
}

void loop() {
  ensureMqttConnection();
  mqttClient.loop();

  // handleRelaySequence(); // Temporarily disabled
  handlePushButtons();
  readIna219ToSerialAndMqtt();
  publishOnlineStatus();
}

void startWiFiConnection() {
  unsigned long now = millis();
  if (WiFi.status() == WL_CONNECTED || now - lastWiFiAttemptTime < WIFI_RETRY_INTERVAL) {
    return;
  }

  lastWiFiAttemptTime = now;
  Serial.print("Starting WiFi connection to ");
  Serial.println(WIFI_SSID);
  WiFi.disconnect(true, true);
  delay(50);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void wifiConnectionTask(void* parameter) {
  bool wasConnected = false;

  for (;;) {
    wl_status_t wifiStatus = WiFi.status();

    if (wifiStatus == WL_CONNECTED) {
      if (!wasConnected) {
        wasConnected = true;
        Serial.print("WiFi connected. IP: ");
        Serial.println(WiFi.localIP());
      }
    } else {
      if (wasConnected) {
        wasConnected = false;
        Serial.println("WiFi disconnected. Background reconnect started.");
      }
      startWiFiConnection();
    }

    vTaskDelay(pdMS_TO_TICKS(500));
  }
}

void ensureMqttConnection() {
  if (WiFi.status() != WL_CONNECTED || mqttClient.connected()) {
    return;
  }

  unsigned long now = millis();
  if (now - lastMqttRetryTime < MQTT_RETRY_INTERVAL) {
    return;
  }
  lastMqttRetryTime = now;

  Serial.print("Connecting to MQTT host: ");
  Serial.println(MQTT_HOST);

  bool connected = mqttClient.connect(
    DEVICE_ID,
    MQTT_USERNAME,
    MQTT_PASSWORD,
    TOPIC_STATUS,
    1,
    true,
    "offline"
  );

  if (connected) {
    Serial.println("MQTT connected.");
    subscribeTopics();
    publishOnlineStatus();
    publishAllRelayStates();
  } else {
    Serial.print("MQTT connect failed, rc=");
    Serial.println(mqttClient.state());
  }
}

void subscribeTopics() {
  for (int i = 0; i < 4; i++) {
    char topic[80];
    snprintf(topic, sizeof(topic), "%s%d%s", TOPIC_RELAY_STATE_PREFIX, i + 1, TOPIC_RELAY_COMMAND_SUFFIX);
    mqttClient.subscribe(topic);
    Serial.print("Subscribed: ");
    Serial.println(topic);
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message;
  for (unsigned int i = 0; i < length; i++) {
    message += static_cast<char>(payload[i]);
  }
  message.trim();

  Serial.print("MQTT RX [");
  Serial.print(topic);
  Serial.print("]: ");
  Serial.println(message);

  for (int i = 0; i < 4; i++) {
    char relayTopic[80];
    snprintf(relayTopic, sizeof(relayTopic), "%s%d%s", TOPIC_RELAY_STATE_PREFIX, i + 1, TOPIC_RELAY_COMMAND_SUFFIX);
    if (strcmp(topic, relayTopic) == 0) {
      bool turnOn = message == "1" || message.equalsIgnoreCase("on") || message.equalsIgnoreCase("true");
      setRelayState(i, turnOn, true);
      return;
    }
  }
}

void handleRelaySequence() {
  unsigned long now = millis();

  if (now - lastStepTime >= STEP_INTERVAL) {
    lastStepTime = now;

    Serial.print("Step: ");
    Serial.println(stepIndex);

    if (stepIndex < 4) {
      setRelayState(stepIndex, true, true);
    } else if (stepIndex < 8) {
      int relayToOff = stepIndex - 4;
      setRelayState(relayToOff, false, true);
    }

    stepIndex++;

    if (stepIndex >= TOTAL_STEPS) {
      stepIndex = 0;
      Serial.println("Cycle repeat");
    }
  }
}

void handlePushButtons() {
  unsigned long now = millis();

  if (now < buttonReadyTime) {
    return;
  }

  for (int i = 0; i < 4; i++) {
    int reading = digitalRead(buttons[i]);

    if (reading != lastButtonReading[i]) {
      lastButtonReading[i] = reading;
      lastButtonChangeTime[i] = now;
    }

    if (now - lastButtonChangeTime[i] < BUTTON_DEBOUNCE_MS) {
      continue;
    }

    if (reading == stableButtonState[i]) {
      continue;
    }

    stableButtonState[i] = reading;

    if (stableButtonState[i] == BUTTON_PRESSED) {
      bool nextRelayState = !relayStates[i];
      Serial.print("Push button ");
      Serial.print(i + 1);
      Serial.print(" toggled relay ");
      Serial.print(i + 1);
      Serial.println(nextRelayState ? " ON" : " OFF");
      setRelayState(i, nextRelayState, true);
    }
  }
}

void setRelayState(uint8_t relayIndex, bool turnOn, bool publishState) {
  if (relayIndex >= 4) {
    return;
  }

  relayStates[relayIndex] = turnOn;
  digitalWrite(relays[relayIndex], turnOn ? RELAY_ON : RELAY_OFF);

  Serial.print("Relay ");
  Serial.print(relayIndex + 1);
  Serial.print(turnOn ? " ON" : " OFF");
  Serial.println();

  if (publishState) {
    publishRelayState(relayIndex);
  }
}

void publishRelayState(uint8_t relayIndex) {
  if (!mqttClient.connected() || relayIndex >= 4) {
    return;
  }

  char topic[80];
  snprintf(topic, sizeof(topic), "%s%d%s", TOPIC_RELAY_STATE_PREFIX, relayIndex + 1, TOPIC_RELAY_STATE_SUFFIX);
  mqttClient.publish(topic, relayStates[relayIndex] ? "1" : "0", true);
}

void publishAllRelayStates() {
  for (int i = 0; i < 4; i++) {
    publishRelayState(i);
  }
}

void readIna219ToSerialAndMqtt() {
  if (!ina219Ready) {
    return;
  }

  unsigned long now = millis();
  if (now - lastIna219ReadTime < INA219_INTERVAL) {
    return;
  }
  lastIna219ReadTime = now;

  float busVoltage = ina219.getBusVoltage_V();
  float shuntVoltage = ina219.getShuntVoltage_mV();
  float current_mA = ina219.getCurrent_mA();
  float loadVoltage = busVoltage + (shuntVoltage / 1000.0f);
  float power_mW = ina219.getPower_mW();
  float currentA = current_mA / 1000.0f;
  float powerW = power_mW / 1000.0f;
  totalEnergyWh += powerW * (INA219_INTERVAL / 3600000.0f);

  float batteryPercent = ((busVoltage - 3.2f) / (4.2f - 3.2f)) * 100.0f;
  if (batteryPercent < 0.0f) batteryPercent = 0.0f;
  if (batteryPercent > 100.0f) batteryPercent = 100.0f;

  Serial.print("INA219 | Bus Voltage: ");
  Serial.print(busVoltage, 2);
  Serial.print(" V | Shunt Voltage: ");
  Serial.print(shuntVoltage, 2);
  Serial.print(" mV | Load Voltage: ");
  Serial.print(loadVoltage, 2);
  Serial.print(" V | Current: ");
  Serial.print(current_mA, 2);
  Serial.print(" mA | Power: ");
  Serial.print(powerW, 3);
  Serial.println(" W");

  if (!mqttClient.connected()) {
    return;
  }

  char payload[320];
  telemetrySequence++;
  snprintf(
    payload,
    sizeof(payload),
    "{\"device\":\"%s\",\"seq\":%lu,\"busVoltage\":%.3f,\"shuntVoltage\":%.3f,\"loadVoltage\":%.3f,\"currentA\":%.3f,\"currentmA\":%.2f,\"powerW\":%.3f,\"powermW\":%.2f,\"energyWh\":%.5f,\"batteryPercent\":%.1f}",
    DEVICE_ID,
    telemetrySequence,
    busVoltage,
    shuntVoltage,
    loadVoltage,
    currentA,
    current_mA,
    powerW,
    power_mW,
    totalEnergyWh,
    batteryPercent
  );
  mqttClient.publish(TOPIC_TELEMETRY, payload, false);
}

void publishOnlineStatus() {
  if (!mqttClient.connected()) {
    return;
  }

  unsigned long now = millis();
  if (now - lastStatusPublishTime < STATUS_INTERVAL) {
    return;
  }
  lastStatusPublishTime = now;

  char payload[96];
  snprintf(payload, sizeof(payload), "online @ %lu", now / 1000UL);
  mqttClient.publish(TOPIC_STATUS, payload, true);
}

void publishOfflineStatus() {
  if (mqttClient.connected()) {
    mqttClient.publish(TOPIC_STATUS, "offline", true);
  }
}
