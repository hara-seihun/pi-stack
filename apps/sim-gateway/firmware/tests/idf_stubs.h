#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include "esp_hf_client_api.h"
#include "esp_gap_bt_api.h"
#define CONFIG_SIM_GATEWAY_ID "test-gateway"
#define pdTRUE 1
#define pdPASS 1
#define pdMS_TO_TICKS(x) (x)
#define ESP_LOGE(...) ((void)0)
#undef ESP_ERROR_CHECK
#define ESP_ERROR_CHECK(x) assert((x) == ESP_OK)
typedef int portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(x) ((void)(x))
#define portEXIT_CRITICAL(x) ((void)(x))
typedef void *QueueHandle_t;
typedef void *esp_websocket_client_handle_t;
typedef const char *esp_event_base_t;
#define WIFI_EVENT ((esp_event_base_t)"wifi")
#define IP_EVENT ((esp_event_base_t)"ip")
#define WIFI_EVENT_STA_START 1
#define WIFI_EVENT_STA_DISCONNECTED 2
#define IP_EVENT_STA_GOT_IP 3
#define WEBSOCKET_EVENT_CONNECTED 1
#define WEBSOCKET_EVENT_DISCONNECTED 2
#define WEBSOCKET_EVENT_ERROR 3
#define WEBSOCKET_EVENT_DATA 4
typedef struct {
    int data_len, payload_len, payload_offset;
    const char *data_ptr;
    bool fin;
    uint8_t op_code;
} esp_websocket_event_data_t;
static int64_t mock_now;
static unsigned mock_dials, mock_hangups, mock_audio_connects, mock_audio_disconnects, mock_confirmations;
static bool mock_connected = true, mock_queue_full;
static char mock_json[16384];
static size_t mock_json_size;
static int64_t esp_timer_get_time(void) { return mock_now; }
static void vTaskDelay(unsigned n) { (void)n; }
static int xQueueSend(void *q, const void *e, unsigned ticks) { (void)q; (void)e; (void)ticks; return !mock_queue_full; }
static int xQueueReceive(void *q, void *e, unsigned ticks) { (void)q; (void)e; (void)ticks; return 0; }
static int esp_websocket_client_send_text(void *c, const char *p, int n, unsigned ticks) {
    (void)c; (void)ticks;
    if (!mock_connected) return -1;
    assert(mock_json_size + n + 2 < sizeof(mock_json));
    memcpy(mock_json + mock_json_size, p, n); mock_json_size += n;
    mock_json[mock_json_size++] = '\n'; mock_json[mock_json_size] = 0;
    return n;
}
static int esp_websocket_client_send_bin(void *c, const char *p, int n, unsigned ticks) {
    (void)c; (void)p; (void)ticks; return mock_connected ? n : -1;
}
static bool esp_websocket_client_is_connected(void *c) { (void)c; return mock_connected; }
static esp_err_t esp_websocket_client_start(void *c) { (void)c; return ESP_OK; }
static esp_err_t esp_websocket_client_stop(void *c) { (void)c; return ESP_OK; }
static esp_err_t esp_wifi_connect(void) { return ESP_OK; }
static unsigned mock_data_ready;
esp_err_t esp_hf_client_dial(const char *n) { assert(n && *n); ++mock_dials; return ESP_OK; }
esp_err_t esp_hf_client_reject_call(void) { ++mock_hangups; return ESP_OK; }
esp_err_t esp_hf_client_connect_audio(esp_bd_addr_t p) { (void)p; ++mock_audio_connects; return ESP_OK; }
esp_err_t esp_hf_client_disconnect_audio(esp_bd_addr_t p) { (void)p; ++mock_audio_disconnects; return ESP_OK; }
esp_err_t esp_hf_client_query_current_calls(void) { return ESP_OK; }
esp_err_t esp_hf_client_connect(esp_bd_addr_t p) { (void)p; return ESP_OK; }
esp_err_t esp_hf_client_disconnect(esp_bd_addr_t p) { (void)p; return ESP_OK; }
void esp_hf_client_outgoing_data_ready(void) { ++mock_data_ready; }
esp_err_t esp_bt_gap_ssp_confirm_reply(esp_bd_addr_t p, bool accept) { (void)p; if (accept) ++mock_confirmations; return ESP_OK; }
esp_err_t esp_bt_gap_pin_reply(esp_bd_addr_t p, bool accept, uint8_t n, esp_bt_pin_code_t pin) {
    (void)p; (void)n; (void)pin; assert(!accept); return ESP_OK;
}
esp_err_t esp_bt_gap_ssp_passkey_reply(esp_bd_addr_t p, bool accept, uint32_t n) {
    (void)p; (void)n; assert(!accept); return ESP_OK;
}
