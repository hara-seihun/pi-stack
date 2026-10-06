#include <stdio.h>
#include <assert.h>
#include <string.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <inttypes.h>
#ifdef SIM_GATEWAY_HOST_TEST
#include "../tests/idf_stubs.h"
#else
#include "sdkconfig.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_bt.h"
#include "esp_bt_main.h"
#include "esp_bt_device.h"
#include "esp_gap_bt_api.h"
#include "esp_hf_client_api.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_crt_bundle.h"
#include "esp_websocket_client.h"
#include "nvs_flash.h"
#endif
#include "cJSON.h"
#include "media.h"

#define MESSAGE_LIMIT 1024
#define EVENT_DEPTH 20
#define RECENT_CALLS 64
static const char *TAG = "sim-gateway";
typedef enum { EV_WS_UP, EV_WS_DOWN, EV_JSON, EV_HFP, EV_PAIR, EV_CONFIRM, EV_WIFI } event_type;
typedef struct {
    event_type type;
    uint32_t epoch;
    int code, value, extra;
    uint8_t address[6];
    char data[MESSAGE_LIMIT + 1];
} event;
static QueueHandle_t events;
static esp_websocket_client_handle_t ws;
static esp_bd_addr_t phone;
static atomic_bool fault, online;
static atomic_uint epoch;
static portMUX_TYPE audio_lock = portMUX_INITIALIZER_UNLOCKED;
static pcm_ring to_phone, to_server;
static pcm_resampler upsampler, downsampler;
static bool media_enabled;
static unsigned sco_rate = 8000;

static struct {
    bool ws_up, hf_ready, hf_connecting, call_present, progress, answered, verified;
    bool active, closing, audio_connecting, pairing, slc, call_known, setup_known, held_known;
    int setup, held, audio_state;
    uint32_t session;
    int64_t deadline, close_deadline, audio_deadline, reconnect_at, heartbeat_at, pair_deadline;
    unsigned pair_number, recent_index;
    char call_id[37], number[17], end_error[48], recent[RECENT_CALLS][37];
} state;

static void mute(void)
{
    portENTER_CRITICAL(&audio_lock);
    media_enabled = false;
    pcm_clear(&to_phone);
    pcm_clear(&to_server);
    memset(&upsampler, 0, sizeof(upsampler));
    memset(&downsampler, 0, sizeof(downsampler));
    portEXIT_CRITICAL(&audio_lock);
}
static void enqueue(const event *e)
{
    if (xQueueSend(events, e, 0) != pdTRUE) {
        mute();
        atomic_store(&fault, true);
    }
}
static bool send_json(cJSON *json)
{
    if (!state.ws_up || !atomic_load(&online)) { cJSON_Delete(json); return false; }
    char *text = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    if (!text) { atomic_store(&fault, true); return false; }
    int n = strlen(text);
    bool ok = state.ws_up && atomic_load(&online) &&
        esp_websocket_client_send_text(ws, text, n, pdMS_TO_TICKS(100)) == n;
    free(text);
    if (!ok) { mute(); atomic_store(&fault, true); }
    return ok;
}
typedef enum { CALL_DIALING, CALL_RINGING, CALL_ACTIVE, CALL_ENDED, CALL_FAILED } call_status;
static const char *call_status_name(call_status status)
{
    switch (status) {
    case CALL_DIALING: return "dialing";
    case CALL_RINGING: return "ringing";
    case CALL_ACTIVE: return "active";
    case CALL_ENDED: return "ended";
    case CALL_FAILED: return "failed";
    }
    return NULL;
}
static void call_state(const char *id, call_status status, const char *error)
{
    const char *name = call_status_name(status);
    if (!name) { mute(); atomic_store(&fault, true); return; }
    if (!state.ws_up) return;
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "type", "call-state");
    cJSON_AddStringToObject(j, "callId", id);
    cJSON_AddStringToObject(j, "state", name);
    if (error && *error) cJSON_AddStringToObject(j, "error", error);
    send_json(j);
}
static void hello(void)
{
    if (!state.ws_up) return;
    bool foreign = (state.call_present || state.setup || state.held) && !state.call_id[0];
    bool ready = state.hf_ready && !foreign && !state.closing;
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "type", "hello");
    cJSON_AddStringToObject(j, "id", CONFIG_SIM_GATEWAY_ID);
    cJSON_AddStringToObject(j, "name", "Kenan SIM bridge");
    cJSON_AddNumberToObject(j, "sampleRate", 16000);
    cJSON_AddBoolToObject(j, "ready", ready);
    if (!ready) cJSON_AddStringToObject(j, "reason", !state.hf_ready ? "phone_hfp_disconnected" :
                                       state.closing ? "call_ending" : "phone_busy");
    send_json(j);
}
static void finish(const char *error)
{
    mute();
    if (state.call_id[0]) call_state(state.call_id, error && *error ? CALL_FAILED : CALL_ENDED, error);
    state.call_id[0] = state.number[0] = state.end_error[0] = 0;
    state.active = state.progress = state.answered = state.verified = state.closing = false;
    state.audio_connecting = false;
    hello();
}
static void lose_ownership(void)
{
    mute();
    state.hf_ready = state.slc = false;
    esp_hf_client_disconnect_audio(phone);
    esp_hf_client_disconnect(phone);
    finish("ownership_lost_hangup_unconfirmed");
}
static void stop_call(const char *error)
{
    mute();
    if (!state.call_id[0] || state.closing) return;
    if (state.call_present && !state.verified) { lose_ownership(); return; }
    state.closing = true;
    snprintf(state.end_error, sizeof(state.end_error), "%s", error ? error : "");
    state.close_deadline = esp_timer_get_time() + 8000000;
    if (esp_hf_client_reject_call() != ESP_OK)
        snprintf(state.end_error, sizeof(state.end_error), "hangup_request_failed");
    hello();
}
static void maybe_active(void)
{
    bool sco = state.audio_state == ESP_HF_CLIENT_AUDIO_STATE_CONNECTED ||
               state.audio_state == ESP_HF_CLIENT_AUDIO_STATE_CONNECTED_MSBC;
    if (!state.call_id[0] || state.closing || !state.answered || !state.verified || state.held) return;
    if (!sco) {
        if (!state.audio_connecting) {
            state.audio_connecting = true;
            state.audio_deadline = esp_timer_get_time() + 8000000;
            if (esp_hf_client_connect_audio(phone) != ESP_OK) stop_call("sco_connect_failed");
        }
        return;
    }
    if (!state.active && state.ws_up && atomic_load(&online)) {
        mute();
        call_state(state.call_id, CALL_ACTIVE, NULL);
        if (atomic_load(&fault)) return;
        state.active = true;
        portENTER_CRITICAL(&audio_lock);
        media_enabled = true;
        portEXIT_CRITICAL(&audio_lock);
        esp_hf_client_outgoing_data_ready();
    }
}

static void incoming_pcm(const uint8_t *buf, uint32_t len)
{
    uint8_t converted[1024];
    if ((len & 1) || len > 512) { mute(); atomic_store(&fault, true); return; }
    portENTER_CRITICAL(&audio_lock);
    if (media_enabled && atomic_load(&online)) {
        size_t size = len;
        const uint8_t *data = buf;
        if (sco_rate == 8000) { size = pcm_upsample(&upsampler, buf, len, converted); data = converted; }
        pcm_push(&to_server, data, size);
    }
    portEXIT_CRITICAL(&audio_lock);
    esp_hf_client_outgoing_data_ready();
}
static uint32_t outgoing_pcm(uint8_t *buf, uint32_t len)
{
    if ((len & 1) || len > 512) return 0;
    portENTER_CRITICAL(&audio_lock);
    bool allowed = media_enabled && atomic_load(&online);
    if (allowed && !pcm_pop(&to_phone, buf, len)) memset(buf, 0, len);
    portEXIT_CRITICAL(&audio_lock);
    return allowed ? len : 0;
}
static void websocket_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    static uint8_t message[MESSAGE_LIMIT + 1];
    static size_t used, expected;
    static int opcode;
    (void)arg; (void)base;
    event e = {0};
    if (id == WEBSOCKET_EVENT_CONNECTED || id == WEBSOCKET_EVENT_DISCONNECTED || id == WEBSOCKET_EVENT_ERROR ||
        id == WEBSOCKET_EVENT_CLOSED || id == WEBSOCKET_EVENT_FINISH) {
        mute(); used = expected = 0;
        atomic_store(&online, id == WEBSOCKET_EVENT_CONNECTED);
        e.type = id == WEBSOCKET_EVENT_CONNECTED ? EV_WS_UP : EV_WS_DOWN;
        e.epoch = atomic_fetch_add(&epoch, 1) + 1;
        enqueue(&e);
        return;
    }
    if (id == WEBSOCKET_EVENT_BEFORE_CONNECT || id == WEBSOCKET_EVENT_BEGIN) return;
    if (id != WEBSOCKET_EVENT_DATA) { mute(); atomic_store(&fault, true); return; }
    esp_websocket_event_data_t *d = data;
    if (d->op_code == 8) { mute(); atomic_store(&online, false); return; }
    if (d->op_code == 9 || d->op_code == 10) return;
    if (d->op_code != 1 && d->op_code != 2) { mute(); atomic_store(&fault, true); return; }
    if (d->payload_offset == 0 && (d->op_code == 1 || d->op_code == 2)) {
        used = 0; expected = d->payload_len; opcode = d->op_code;
    }
    if (d->payload_len < 0 || d->payload_len > MESSAGE_LIMIT || d->payload_offset < 0 ||
        (size_t)d->payload_offset != used || d->data_len < 0 || used + d->data_len > expected) {
        mute(); atomic_store(&fault, true); return;
    }
    memcpy(message + used, d->data_ptr, d->data_len);
    used += d->data_len;
    if (used != expected) return;
    /* Application messages must be one RFC6455 frame, not continuation frames. */
    if (!d->fin) { mute(); atomic_store(&fault, true); return; }
    if (opcode == 2) {
        if (used != PCM_FRAME_BYTES) { mute(); atomic_store(&fault, true); return; }
        uint8_t converted[PCM_FRAME_BYTES];
        portENTER_CRITICAL(&audio_lock);
        if (media_enabled && atomic_load(&online)) {
            size_t n = used;
            const uint8_t *p = message;
            if (sco_rate == 8000) { n = pcm_downsample(&downsampler, message, used, converted); p = converted; }
            pcm_push(&to_phone, p, n);
        }
        portEXIT_CRITICAL(&audio_lock);
        esp_hf_client_outgoing_data_ready();
    } else if (opcode == 1) {
        e.type = EV_JSON; e.epoch = atomic_load(&epoch);
        memcpy(e.data, message, used); e.data[used] = 0;
        enqueue(&e);
    }
    used = expected = 0;
}
static void hf_callback(esp_hf_client_cb_event_t id, esp_hf_client_cb_param_t *p)
{
    event e = {.type = EV_HFP, .code = id};
    switch (id) {
    case ESP_HF_CLIENT_CONNECTION_STATE_EVT:
        e.value = p->conn_stat.state; memcpy(e.address, p->conn_stat.remote_bda, 6);
        if (e.value != ESP_HF_CLIENT_CONNECTION_STATE_SLC_CONNECTED) mute();
        enqueue(&e); return;
    case ESP_HF_CLIENT_AUDIO_STATE_EVT:
        e.value = p->audio_stat.state; memcpy(e.address, p->audio_stat.remote_bda, 6);
        mute();
        enqueue(&e); return;
    case ESP_HF_CLIENT_CIND_CALL_EVT: e.value = p->call.status; if (!e.value) mute(); enqueue(&e); return;
    case ESP_HF_CLIENT_CIND_CALL_SETUP_EVT: e.value = p->call_setup.status; if (e.value == 1) mute(); enqueue(&e); return;
    case ESP_HF_CLIENT_CIND_CALL_HELD_EVT: e.value = p->call_held.status; if (e.value) mute(); enqueue(&e); return;
    case ESP_HF_CLIENT_AT_RESPONSE_EVT: e.value = p->at_response.code; enqueue(&e); return;
    case ESP_HF_CLIENT_PROF_STATE_EVT: e.value = p->prof_stat.state; enqueue(&e); return;
    case ESP_HF_CLIENT_CLCC_EVT:
        e.value = p->clcc.status; e.extra = p->clcc.dir;
        if (p->clcc.number) snprintf(e.data, sizeof(e.data), "%s", p->clcc.number);
        enqueue(&e); return;
    case ESP_HF_CLIENT_RING_IND_EVT: enqueue(&e); return;
    case ESP_HF_CLIENT_BVRA_EVT:
    case ESP_HF_CLIENT_CIND_SERVICE_AVAILABILITY_EVT:
    case ESP_HF_CLIENT_CIND_SIGNAL_STRENGTH_EVT:
    case ESP_HF_CLIENT_CIND_ROAMING_STATUS_EVT:
    case ESP_HF_CLIENT_CIND_BATTERY_LEVEL_EVT:
    case ESP_HF_CLIENT_COPS_CURRENT_OPERATOR_EVT:
    case ESP_HF_CLIENT_BTRH_EVT:
    case ESP_HF_CLIENT_CLIP_EVT:
    case ESP_HF_CLIENT_CCWA_EVT:
    case ESP_HF_CLIENT_VOLUME_CONTROL_EVT:
    case ESP_HF_CLIENT_CNUM_EVT:
    case ESP_HF_CLIENT_BSIR_EVT:
    case ESP_HF_CLIENT_BINP_EVT:
    case ESP_HF_CLIENT_PKT_STAT_NUMS_GET_EVT:
        return;
    }
    mute(); atomic_store(&fault, true);
}
static void gap_callback(esp_bt_gap_cb_event_t id, esp_bt_gap_cb_param_t *p)
{
    if (id == ESP_BT_GAP_CFM_REQ_EVT) {
        if (memcmp(p->cfm_req.bda, phone, 6)) {
            esp_bt_gap_ssp_confirm_reply(p->cfm_req.bda, false);
            return;
        }
        event e = {.type = EV_PAIR, .value = p->cfm_req.num_val};
        memcpy(e.address, p->cfm_req.bda, 6); enqueue(&e);
    } else if (id == ESP_BT_GAP_PIN_REQ_EVT) {
        esp_bt_pin_code_t pin = {0};
        esp_bt_gap_pin_reply(p->pin_req.bda, false, 0, pin);
    } else if (id == ESP_BT_GAP_KEY_REQ_EVT) {
        esp_bt_gap_ssp_passkey_reply(p->key_req.bda, false, 0);
    } else {
        switch (id) {
        case ESP_BT_GAP_DISC_RES_EVT:
        case ESP_BT_GAP_DISC_STATE_CHANGED_EVT:
        case ESP_BT_GAP_RMT_SRVCS_EVT:
        case ESP_BT_GAP_RMT_SRVC_REC_EVT:
        case ESP_BT_GAP_AUTH_CMPL_EVT:
        case ESP_BT_GAP_KEY_NOTIF_EVT:
        case ESP_BT_GAP_READ_RSSI_DELTA_EVT:
        case ESP_BT_GAP_CONFIG_EIR_DATA_EVT:
        case ESP_BT_GAP_SET_AFH_CHANNELS_EVT:
        case ESP_BT_GAP_READ_REMOTE_NAME_EVT:
        case ESP_BT_GAP_MODE_CHG_EVT:
        case ESP_BT_GAP_REMOVE_BOND_DEV_COMPLETE_EVT:
        case ESP_BT_GAP_QOS_CMPL_EVT:
        case ESP_BT_GAP_ACL_CONN_CMPL_STAT_EVT:
        case ESP_BT_GAP_ACL_DISCONN_CMPL_STAT_EVT:
        case ESP_BT_GAP_SET_PAGE_TO_EVT:
        case ESP_BT_GAP_GET_PAGE_TO_EVT:
        case ESP_BT_GAP_ACL_PKT_TYPE_CHANGED_EVT:
        case ESP_BT_GAP_ENC_CHG_EVT:
        case ESP_BT_GAP_SET_MIN_ENC_KEY_SIZE_EVT:
        case ESP_BT_GAP_GET_DEV_NAME_CMPL_EVT:
            return;
        case ESP_BT_GAP_PIN_REQ_EVT:
        case ESP_BT_GAP_CFM_REQ_EVT:
        case ESP_BT_GAP_KEY_REQ_EVT:
        case ESP_BT_GAP_EVT_MAX:
            break;
        }
        mute(); atomic_store(&fault, true);
    }
}
static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)data;
    if (base == WIFI_EVENT && (id == WIFI_EVENT_STA_START || id == WIFI_EVENT_STA_DISCONNECTED)) {
        if (id == WIFI_EVENT_STA_DISCONNECTED) { mute(); atomic_store(&online, false); event e = {.type = EV_WS_DOWN}; enqueue(&e); }
        if (esp_wifi_connect() != ESP_OK) atomic_store(&fault, true);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        event e = {.type = EV_WIFI}; enqueue(&e);
    } else {
        mute(); atomic_store(&fault, true);
    }
}
static void console_task(void *arg)
{
    (void)arg;
    char line[32]; size_t used = 0;
    for (;;) {
        int c = getchar();
        if (c == EOF) { clearerr(stdin); vTaskDelay(pdMS_TO_TICKS(20)); continue; }
        if (c == '\n' || c == '\r') {
            line[used] = 0;
            unsigned n; char extra;
            if (sscanf(line, "confirm %u %c", &n, &extra) == 1 && n <= 999999) {
                event e = {.type = EV_CONFIRM, .value = n}; enqueue(&e);
            }
            used = 0;
        } else if (used + 1 < sizeof(line)) line[used++] = c;
        else used = 0;
    }
}
static bool seen_call(const char *id)
{
    for (unsigned i = 0; i < RECENT_CALLS; ++i)
        if (!strcmp(state.recent[i], id)) return true;
    return false;
}
static void command(const char *text)
{
    cJSON *j = cJSON_ParseWithOpts(text, NULL, true);
    if (!j) { stop_call("invalid_command"); atomic_store(&fault, true); return; }
    const cJSON *type = cJSON_GetObjectItemCaseSensitive(j, "type");
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(j, "callId");
    if (!cJSON_IsString(type) || !cJSON_IsString(id) || !valid_call_id(id->valuestring)) {
        cJSON_Delete(j); stop_call("invalid_command"); atomic_store(&fault, true); return;
    }
    if (!strcmp(type->valuestring, "hangup")) {
        if (!strcmp(id->valuestring, state.call_id)) stop_call(NULL);
        else call_state(id->valuestring, CALL_FAILED, "unknown_call");
    } else if (!strcmp(type->valuestring, "dial")) {
        const cJSON *number = cJSON_GetObjectItemCaseSensitive(j, "number");
        const cJSON *seconds = cJSON_GetObjectItemCaseSensitive(j, "maxSeconds");
        const char *error = NULL;
        if (seen_call(id->valuestring)) error = "duplicate_call";
        else if (!cJSON_IsString(number) || !valid_e164(number->valuestring) || !cJSON_IsNumber(seconds) ||
                 seconds->valuedouble < 30 || seconds->valuedouble > 1800 ||
                 seconds->valuedouble != seconds->valueint) error = "invalid_dial";
        else if (!state.hf_ready) error = "phone_hfp_disconnected";
        else if (state.call_id[0] || state.call_present || state.setup || state.held) error = "phone_busy";
        if (error) {
            /* A duplicate of the current call must not terminally fail its reservation. */
            if (strcmp(id->valuestring, state.call_id)) call_state(id->valuestring, CALL_FAILED, error);
        } else {
            snprintf(state.recent[state.recent_index++ % RECENT_CALLS], 37, "%s", id->valuestring);
            snprintf(state.call_id, sizeof(state.call_id), "%s", id->valuestring);
            snprintf(state.number, sizeof(state.number), "%s", number->valuestring);
            state.deadline = esp_timer_get_time() + (int64_t)seconds->valueint * 1000000;
            state.progress = state.answered = state.verified = state.active = state.closing = false;
            mute();
            call_state(state.call_id, CALL_DIALING, NULL);
            if (atomic_load(&online) && !atomic_load(&fault)) {
                if (esp_hf_client_dial(state.number) != ESP_OK) finish("dial_request_failed");
            } else finish("server_disconnected_before_dial");
        }
    } else {
        stop_call("invalid_command"); atomic_store(&fault, true);
    }
    cJSON_Delete(j);
}
static bool valid_hfp(const event *e)
{
    switch (e->code) {
    case ESP_HF_CLIENT_CONNECTION_STATE_EVT:
        return e->value == ESP_HF_CLIENT_CONNECTION_STATE_DISCONNECTED ||
            e->value == ESP_HF_CLIENT_CONNECTION_STATE_CONNECTING ||
            e->value == ESP_HF_CLIENT_CONNECTION_STATE_CONNECTED ||
            e->value == ESP_HF_CLIENT_CONNECTION_STATE_SLC_CONNECTED ||
            e->value == ESP_HF_CLIENT_CONNECTION_STATE_DISCONNECTING;
    case ESP_HF_CLIENT_AUDIO_STATE_EVT:
        return e->value == ESP_HF_CLIENT_AUDIO_STATE_DISCONNECTED ||
            e->value == ESP_HF_CLIENT_AUDIO_STATE_CONNECTING ||
            e->value == ESP_HF_CLIENT_AUDIO_STATE_CONNECTED ||
            e->value == ESP_HF_CLIENT_AUDIO_STATE_CONNECTED_MSBC;
    case ESP_HF_CLIENT_CIND_CALL_EVT:
        return e->value == ESP_HF_CALL_STATUS_NO_CALLS || e->value == ESP_HF_CALL_STATUS_CALL_IN_PROGRESS;
    case ESP_HF_CLIENT_CIND_CALL_SETUP_EVT:
        return e->value == ESP_HF_CALL_SETUP_STATUS_IDLE || e->value == ESP_HF_CALL_SETUP_STATUS_INCOMING ||
            e->value == ESP_HF_CALL_SETUP_STATUS_OUTGOING_DIALING || e->value == ESP_HF_CALL_SETUP_STATUS_OUTGOING_ALERTING;
    case ESP_HF_CLIENT_CIND_CALL_HELD_EVT:
        return e->value == ESP_HF_CALL_HELD_STATUS_NONE || e->value == ESP_HF_CALL_HELD_STATUS_HELD_AND_ACTIVE ||
            e->value == ESP_HF_CALL_HELD_STATUS_HELD;
    case ESP_HF_CLIENT_CLCC_EVT:
        return (e->extra == ESP_HF_CURRENT_CALL_DIRECTION_OUTGOING || e->extra == ESP_HF_CURRENT_CALL_DIRECTION_INCOMING) &&
            (e->value == ESP_HF_CURRENT_CALL_STATUS_ACTIVE || e->value == ESP_HF_CURRENT_CALL_STATUS_HELD ||
             e->value == ESP_HF_CURRENT_CALL_STATUS_DIALING || e->value == ESP_HF_CURRENT_CALL_STATUS_ALERTING ||
             e->value == ESP_HF_CURRENT_CALL_STATUS_INCOMING || e->value == ESP_HF_CURRENT_CALL_STATUS_WAITING ||
             e->value == ESP_HF_CURRENT_CALL_STATUS_HELD_BY_RESP_HOLD);
    case ESP_HF_CLIENT_AT_RESPONSE_EVT:
        return e->value == ESP_HF_AT_RESPONSE_CODE_OK || e->value == ESP_HF_AT_RESPONSE_CODE_ERR ||
            e->value == ESP_HF_AT_RESPONSE_CODE_NO_CARRIER || e->value == ESP_HF_AT_RESPONSE_CODE_BUSY ||
            e->value == ESP_HF_AT_RESPONSE_CODE_NO_ANSWER || e->value == ESP_HF_AT_RESPONSE_CODE_DELAYED ||
            e->value == ESP_HF_AT_RESPONSE_CODE_BLACKLISTED || e->value == ESP_HF_AT_RESPONSE_CODE_CME;
    case ESP_HF_CLIENT_PROF_STATE_EVT:
        return e->value == ESP_HF_INIT_SUCCESS || e->value == ESP_HF_INIT_ALREADY || e->value == ESP_HF_INIT_FAIL ||
            e->value == ESP_HF_DEINIT_SUCCESS || e->value == ESP_HF_DEINIT_ALREADY || e->value == ESP_HF_DEINIT_FAIL;
    case ESP_HF_CLIENT_RING_IND_EVT: return true;
    }
    return false;
}
static void handle_hfp(const event *e)
{
    if (!valid_hfp(e)) {
        ESP_LOGE(TAG, "Invalid HFP event/state: %d/%d", e->code, e->value);
        lose_ownership(); return;
    }
    switch (e->code) {
    case ESP_HF_CLIENT_PROF_STATE_EVT:
        if (e->value == ESP_HF_INIT_SUCCESS) state.reconnect_at = 0;
        break;
    case ESP_HF_CLIENT_CONNECTION_STATE_EVT:
        if (memcmp(e->address, phone, 6)) { esp_hf_client_disconnect((uint8_t *)e->address); return; }
        state.hf_connecting = e->value != ESP_HF_CLIENT_CONNECTION_STATE_DISCONNECTED;
        state.slc = e->value == ESP_HF_CLIENT_CONNECTION_STATE_SLC_CONNECTED;
        if (e->value == ESP_HF_CLIENT_CONNECTION_STATE_CONNECTING ||
            e->value == ESP_HF_CLIENT_CONNECTION_STATE_CONNECTED) {
            state.call_known = state.setup_known = state.held_known = false;
        }
        state.hf_ready = state.slc && state.call_known && state.setup_known && state.held_known;
        if (e->value == ESP_HF_CLIENT_CONNECTION_STATE_DISCONNECTED) {
            state.audio_state = ESP_HF_CLIENT_AUDIO_STATE_DISCONNECTED;
            state.reconnect_at = esp_timer_get_time() + 5000000;
            if (state.call_id[0]) finish("hfp_disconnected_hangup_unconfirmed");
        }
        hello(); break;
    case ESP_HF_CLIENT_AUDIO_STATE_EVT:
        if (memcmp(e->address, phone, 6)) return;
        state.audio_state = e->value;
        if (e->value == ESP_HF_CLIENT_AUDIO_STATE_CONNECTED || e->value == ESP_HF_CLIENT_AUDIO_STATE_CONNECTED_MSBC) state.active = false;
        portENTER_CRITICAL(&audio_lock);
        if (e->value == ESP_HF_CLIENT_AUDIO_STATE_CONNECTED) sco_rate = 8000;
        else if (e->value == ESP_HF_CLIENT_AUDIO_STATE_CONNECTED_MSBC) sco_rate = 16000;
        portEXIT_CRITICAL(&audio_lock);
        if (!state.call_id[0] && (e->value == ESP_HF_CLIENT_AUDIO_STATE_CONNECTED || e->value == ESP_HF_CLIENT_AUDIO_STATE_CONNECTED_MSBC))
            esp_hf_client_disconnect_audio(phone);
        if (state.active && e->value == ESP_HF_CLIENT_AUDIO_STATE_DISCONNECTED) stop_call("sco_disconnected");
        maybe_active(); break;
    case ESP_HF_CLIENT_CIND_CALL_EVT:
        state.call_known = true;
        state.call_present = e->value != 0;
        state.hf_ready = state.slc && state.setup_known && state.held_known;
        if (state.call_present && state.call_id[0]) {
            state.answered = state.progress = true;
            if (esp_hf_client_query_current_calls() != ESP_OK) stop_call("call_identity_query_failed");
            state.audio_deadline = esp_timer_get_time() + 8000000;
        } else if (!state.call_present && state.call_id[0] && state.progress && !state.setup) finish(state.end_error);
        if (!state.call_present) state.answered = false;
        hello(); break;
    case ESP_HF_CLIENT_CIND_CALL_SETUP_EVT:
        state.setup_known = true;
        state.setup = e->value;
        state.hf_ready = state.slc && state.call_known && state.held_known;
        if (e->value == ESP_HF_CALL_SETUP_STATUS_INCOMING) {
            if (state.call_id[0]) lose_ownership();
        } else if (e->value == ESP_HF_CALL_SETUP_STATUS_OUTGOING_DIALING && state.call_id[0]) state.progress = true;
        else if (e->value == ESP_HF_CALL_SETUP_STATUS_OUTGOING_ALERTING && state.call_id[0]) {
            state.progress = true; call_state(state.call_id, CALL_RINGING, NULL);
        } else if (!e->value && !state.call_present && state.progress && state.call_id[0]) finish(state.end_error);
        hello(); break;
    case ESP_HF_CLIENT_CIND_CALL_HELD_EVT:
        state.held_known = true;
        state.held = e->value;
        state.hf_ready = state.slc && state.call_known && state.setup_known;
        if (e->value && state.call_id[0]) lose_ownership();
        hello(); break;
    case ESP_HF_CLIENT_CLCC_EVT:
        if (state.call_id[0] && e->value == ESP_HF_CURRENT_CALL_STATUS_ACTIVE) {
            bool same = !strcmp(e->data, state.number) || !strcmp(e->data, state.number + 1);
            if (e->extra != ESP_HF_CURRENT_CALL_DIRECTION_OUTGOING || !same) lose_ownership();
            else { state.verified = true; maybe_active(); }
        }
        break;
    case ESP_HF_CLIENT_AT_RESPONSE_EVT:
        if (state.call_id[0] && e->value != ESP_HF_AT_RESPONSE_CODE_OK) stop_call("phone_at_error");
        break;
    case ESP_HF_CLIENT_RING_IND_EVT: hello(); break;
    }
}
static void handle_event(event e)
{
    if (e.type != EV_WIFI && e.type != EV_WS_UP && e.type != EV_WS_DOWN && e.type != EV_JSON &&
        e.type != EV_HFP && e.type != EV_PAIR && e.type != EV_CONFIRM) {
        ESP_LOGE(TAG, "Invalid gateway event: %d", e.type);
        mute(); atomic_store(&fault, true); return;
    }
            switch (e.type) {
            case EV_WIFI:
                if (!esp_websocket_client_is_connected(ws)) {
                    esp_err_t err = esp_websocket_client_start(ws);
                    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) atomic_store(&fault, true);
                }
                break;
            case EV_WS_UP:
                stop_call("server_session_changed");
                state.ws_up = true; state.session = e.epoch;
                state.heartbeat_at = 0; hello(); break;
            case EV_WS_DOWN:
                state.ws_up = false; stop_call("server_disconnected"); break;
            case EV_JSON:
                if (state.ws_up && e.epoch == state.session && e.epoch == atomic_load(&epoch) && atomic_load(&online)) command(e.data);
                break;
            case EV_HFP: handle_hfp(&e); break;
            case EV_PAIR:
                if (state.pairing) esp_bt_gap_ssp_confirm_reply(phone, false);
                state.pairing = true; state.pair_number = e.value;
                state.pair_deadline = esp_timer_get_time() + 30000000;
                printf("Compare %06u on the allowed phone; USB console: confirm %06u\n", state.pair_number, state.pair_number);
                break;
            case EV_CONFIRM:
                if (state.pairing && state.pair_number == (unsigned)e.value && esp_timer_get_time() < state.pair_deadline) {
                    ESP_ERROR_CHECK(esp_bt_gap_ssp_confirm_reply(phone, true)); state.pairing = false;
                }
                break;
            }
}
static void maintenance(int64_t now)
{
        if (atomic_exchange(&fault, false)) {
            stop_call("transport_or_queue_error"); state.ws_up = false;
            atomic_store(&online, false);
            esp_websocket_client_stop(ws);
            if (esp_websocket_client_start(ws) != ESP_OK) ESP_LOGE(TAG, "WebSocket restart failed");
        }
        if (state.pairing && now >= state.pair_deadline) { esp_bt_gap_ssp_confirm_reply(phone, false); state.pairing = false; }
        if (state.call_id[0] && !state.closing) {
            if (now >= state.deadline) stop_call("max_seconds_reached");
            else if (state.answered && !state.active && now >= state.audio_deadline) stop_call("sco_or_identity_timeout");
        }
        if (state.closing && now >= state.close_deadline) {
            state.hf_ready = false;
            esp_hf_client_disconnect(phone);
            finish("hangup_unconfirmed");
        }
        if (!state.hf_connecting && now >= state.reconnect_at) {
            state.reconnect_at = now + 5000000;
            if (esp_hf_client_connect(phone) == ESP_OK) state.hf_connecting = true;
        }
        if (state.ws_up && now >= state.heartbeat_at) {
            state.heartbeat_at = now + 15000000;
            cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "type", "heartbeat"); send_json(j);
        }
}
static void gateway_task(void *arg)
{
    (void)arg;
    event e;
    int64_t frame_at = esp_timer_get_time();
    for (;;) {
        if (xQueueReceive(events, &e, pdMS_TO_TICKS(5)) == pdTRUE) handle_event(e);
        int64_t now = esp_timer_get_time();
        maintenance(now);
        if (now >= frame_at) {
            frame_at += 20000;
            if (frame_at <= now) frame_at = now + 20000;
            uint8_t frame[PCM_FRAME_BYTES];
            portENTER_CRITICAL(&audio_lock);
            bool available = media_enabled && pcm_pop(&to_server, frame, sizeof(frame));
            portEXIT_CRITICAL(&audio_lock);
            if (available && state.ws_up && atomic_load(&online) &&
                esp_websocket_client_send_bin(ws, (char *)frame, sizeof(frame), pdMS_TO_TICKS(20)) != sizeof(frame)) {
                mute(); atomic_store(&fault, true);
            }
        }
    }
}
#ifndef SIM_GATEWAY_HOST_TEST
void app_main(void)
{
    if (!*CONFIG_SIM_WIFI_SSID || !*CONFIG_SIM_DEVICE_TOKEN || !*CONFIG_SIM_GATEWAY_ID ||
        strncmp(CONFIG_SIM_SERVER_URL, "wss://", 6) || strchr(CONFIG_SIM_DEVICE_TOKEN, '\r') ||
        strchr(CONFIG_SIM_DEVICE_TOKEN, '\n')) {
        ESP_LOGE(TAG, "Owner provisioning missing or invalid; no radio/calls started"); return;
    }
    unsigned b[6]; char trailing;
    if (sscanf(CONFIG_SIM_PHONE_BDA, "%2x:%2x:%2x:%2x:%2x:%2x%c", &b[0], &b[1], &b[2], &b[3], &b[4], &b[5], &trailing) != 6) {
        ESP_LOGE(TAG, "Allowed phone Bluetooth address invalid"); return;
    }
    for (unsigned i = 0; i < 6; ++i) phone[i] = b[i];
    /* Do not erase NVS on an initialization error: it owns Bluetooth bonds. */
    ESP_ERROR_CHECK(nvs_flash_init());
    events = xQueueCreate(EVENT_DEPTH, sizeof(event));
    assert(events);
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t wifi_init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&wifi_init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_STA_START, wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));
    wifi_config_t wifi = {0};
    snprintf((char *)wifi.sta.ssid, sizeof(wifi.sta.ssid), "%s", CONFIG_SIM_WIFI_SSID);
    snprintf((char *)wifi.sta.password, sizeof(wifi.sta.password), "%s", CONFIG_SIM_WIFI_PASSWORD);
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi));
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    ESP_ERROR_CHECK(esp_bt_controller_mem_release(ESP_BT_MODE_BLE));
    esp_bt_controller_config_t bt = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_bt_controller_init(&bt));
    ESP_ERROR_CHECK(esp_bt_controller_enable(ESP_BT_MODE_CLASSIC_BT));
    ESP_ERROR_CHECK(esp_bluedroid_init());
    ESP_ERROR_CHECK(esp_bluedroid_enable());
    ESP_ERROR_CHECK(esp_bt_gap_register_callback(gap_callback));
    esp_bt_io_cap_t cap = ESP_BT_IO_CAP_IO;
    ESP_ERROR_CHECK(esp_bt_gap_set_security_param(ESP_BT_SP_IOCAP_MODE, &cap, sizeof(cap)));
    ESP_ERROR_CHECK(esp_bt_gap_set_device_name("Kenan SIM bridge"));
    ESP_ERROR_CHECK(esp_bt_gap_set_scan_mode(ESP_BT_CONNECTABLE, ESP_BT_GENERAL_DISCOVERABLE));
    ESP_ERROR_CHECK(esp_hf_client_register_callback(hf_callback));
    ESP_ERROR_CHECK(esp_hf_client_init());
    ESP_ERROR_CHECK(esp_hf_client_register_data_callback(incoming_pcm, outgoing_pcm));
    char *headers = malloc(strlen(CONFIG_SIM_DEVICE_TOKEN) + 32);
    assert(headers);
    sprintf(headers, "Authorization: Bearer %s\r\n", CONFIG_SIM_DEVICE_TOKEN);
    esp_websocket_client_config_t conf = {
        .uri = CONFIG_SIM_SERVER_URL, .headers = headers,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .reconnect_timeout_ms = 5000, .network_timeout_ms = 5000,
        .buffer_size = MESSAGE_LIMIT, .task_stack = 6144,
        .ping_interval_sec = 15, .pingpong_timeout_sec = 30,
    };
    ws = esp_websocket_client_init(&conf);
    assert(ws);
    free(headers);
    ESP_ERROR_CHECK(esp_websocket_register_events(ws, WEBSOCKET_EVENT_ANY, websocket_event, NULL));
    assert(xTaskCreatePinnedToCore(gateway_task, "gateway", 8192, NULL, 5, NULL, 0) == pdPASS);
    assert(xTaskCreate(console_task, "pair-consent", 3072, NULL, 2, NULL) == pdPASS);
    ESP_ERROR_CHECK(esp_wifi_start());
}
#endif
