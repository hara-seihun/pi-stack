#define SIM_GATEWAY_HOST_TEST
#include "../main/gateway.c"

static const char *ID = "12345678-1234-4567-89ab-123456789abc";
static unsigned checks;
#define CHECK(x) do { ++checks; assert(x); } while (0)
static void reset(void)
{
    memset(&state, 0, sizeof(state)); mute();
    state.ws_up = state.hf_ready = state.slc = state.call_known = state.setup_known = state.held_known = true;
    state.session = 1; atomic_store(&epoch, 1); atomic_store(&online, true); atomic_store(&fault, false);
    mock_now = 0; mock_connected = true; mock_queue_full = false;
    mock_dials = mock_hangups = mock_audio_connects = mock_audio_disconnects = mock_confirmations = 0;
    mock_json_size = 0; mock_json[0] = 0; sco_rate = 16000;
}
static void hf(int code, int value)
{
    event e = {.type = EV_HFP, .code = code, .value = value};
    memcpy(e.address, phone, 6); handle_hfp(&e);
}
static void dial(void)
{
    command("{\"type\":\"dial\",\"callId\":\"12345678-1234-4567-89ab-123456789abc\",\"number\":\"+15551234567\",\"maxSeconds\":30}");
}
static void activate(void)
{
    dial(); hf(ESP_HF_CLIENT_CIND_CALL_SETUP_EVT, ESP_HF_CALL_SETUP_STATUS_OUTGOING_DIALING);
    hf(ESP_HF_CLIENT_CIND_CALL_EVT, 1); hf(ESP_HF_CLIENT_CIND_CALL_SETUP_EVT, 0);
    event e = {.code = ESP_HF_CLIENT_CLCC_EVT, .value = ESP_HF_CURRENT_CALL_STATUS_ACTIVE,
               .extra = ESP_HF_CURRENT_CALL_DIRECTION_OUTGOING};
    strcpy(e.data, "+15551234567"); handle_hfp(&e);
    hf(ESP_HF_CLIENT_AUDIO_STATE_EVT, ESP_HF_CLIENT_AUDIO_STATE_CONNECTED_MSBC);
    CHECK(state.active && media_enabled);
}
static void test_call_control(void)
{
    reset(); dial(); CHECK(mock_dials == 1); CHECK(!state.active && !media_enabled);
    dial(); CHECK(mock_dials == 1); CHECK(!strstr(mock_json, "duplicate_call"));
    hf(ESP_HF_CLIENT_CIND_CALL_SETUP_EVT, 2); hf(ESP_HF_CLIENT_CIND_CALL_EVT, 1);
    CHECK(!state.active && !media_enabled);
    hf(ESP_HF_CLIENT_AUDIO_STATE_EVT, ESP_HF_CLIENT_AUDIO_STATE_CONNECTED_MSBC);
    CHECK(!state.active && !media_enabled);
    event identity = {.code = ESP_HF_CLIENT_CLCC_EVT, .value = ESP_HF_CURRENT_CALL_STATUS_ACTIVE,
                      .extra = ESP_HF_CURRENT_CALL_DIRECTION_OUTGOING};
    strcpy(identity.data, "+15551234567"); handle_hfp(&identity);
    CHECK(state.active && media_enabled); CHECK(strstr(mock_json, "\"state\":\"active\""));
    hf(ESP_HF_CLIENT_CIND_CALL_SETUP_EVT, 0);
    hello(); CHECK(strstr(mock_json, "\"ready\":true"));
    command("{\"type\":\"hangup\",\"callId\":\"12345678-1234-4567-89ab-123456789abc\"}");
    CHECK(mock_hangups == 1 && state.call_id[0] && state.closing && !media_enabled);
    CHECK(!strstr(mock_json, "\"state\":\"ended\""));
    hf(ESP_HF_CLIENT_CIND_CALL_EVT, 0);
    CHECK(!state.call_id[0] && strstr(mock_json, "\"state\":\"ended\""));
    dial(); CHECK(mock_dials == 1 && strstr(mock_json, "duplicate_call"));

    reset(); state.setup = 1; dial(); CHECK(mock_dials == 0 && strstr(mock_json, "phone_busy"));
    reset(); hf(ESP_HF_CLIENT_CIND_CALL_EVT, 1); CHECK(!media_enabled && !mock_audio_connects);
    hello(); CHECK(strstr(mock_json, "\"ready\":false")); dial(); CHECK(mock_dials == 0);
    reset(); hf(ESP_HF_CLIENT_AUDIO_STATE_EVT, ESP_HF_CLIENT_AUDIO_STATE_CONNECTED_MSBC);
    CHECK(!media_enabled && mock_audio_disconnects == 1);
    reset(); hf(ESP_HF_CLIENT_CIND_CALL_SETUP_EVT, 1);
    CHECK(!mock_dials && !mock_hangups && !media_enabled && strstr(mock_json, "phone_busy"));

    reset(); dial(); hf(ESP_HF_CLIENT_CIND_CALL_EVT, 1);
    strcpy(identity.data, "+15559999999"); handle_hfp(&identity);
    CHECK(!state.call_id[0] && !media_enabled && mock_hangups == 0 && !state.hf_ready);
    reset(); dial(); hf(ESP_HF_CLIENT_CIND_CALL_EVT, 1);
    strcpy(identity.data, "+15551234567"); identity.extra = ESP_HF_CURRENT_CALL_DIRECTION_INCOMING;
    handle_hfp(&identity); CHECK(!state.call_id[0] && !media_enabled && !mock_hangups);
    reset(); activate(); hf(ESP_HF_CLIENT_CIND_CALL_HELD_EVT, 1);
    CHECK(!media_enabled && !state.call_id[0] && !mock_hangups);

    reset(); command("{\"type\":\"dial\",\"callId\":\"12345678-1234-4567-89ab-123456789abc\",\"number\":\"+1555;ATD+1999\",\"maxSeconds\":30}");
    CHECK(!mock_dials && strstr(mock_json, "invalid_dial"));
    reset(); command("{\"type\":\"dial\",\"callId\":\"12345678-1234-4567-89ab-123456789abc\",\"number\":\"+15551234567\",\"maxSeconds\":29}");
    CHECK(!mock_dials);
}
static void test_session_and_watchdog(void)
{
    reset(); activate();
    uint8_t audio[240] = {1}; incoming_pcm(audio, sizeof(audio)); CHECK(to_server.count == 240);
    atomic_store(&online, false);
    event down = {.type = EV_WS_DOWN}; handle_event(down);
    CHECK(state.closing && !media_enabled && !to_server.count && !to_phone.count && mock_hangups == 1);
    atomic_store(&online, true); atomic_store(&epoch, 3);
    event up = {.type = EV_WS_UP, .epoch = 3}; handle_event(up);
    CHECK(state.session == 3 && state.closing && mock_dials == 1);
    event old = {.type = EV_JSON, .epoch = 1};
    strcpy(old.data, "{\"type\":\"dial\",\"callId\":\"12345678-1234-4567-89ab-111111111111\",\"number\":\"+15551234567\",\"maxSeconds\":30}");
    handle_event(old); CHECK(mock_dials == 1);
    hf(ESP_HF_CLIENT_CIND_CALL_EVT, 0); CHECK(!state.call_id[0]);
    handle_event(down); CHECK(mock_hangups == 1);

    reset(); activate(); mock_now = 30000000; maintenance(mock_now);
    CHECK(state.closing && mock_hangups == 1 && !media_enabled);
    mock_now += 8000000; maintenance(mock_now);
    CHECK(!state.call_id[0] && !state.hf_ready && strstr(mock_json, "hangup_unconfirmed"));
    reset(); dial(); hf(ESP_HF_CLIENT_CIND_CALL_EVT, 1); mock_now = 8000000; maintenance(mock_now);
    CHECK(!state.call_id[0] && !state.hf_ready && !mock_hangups && strstr(mock_json, "ownership_lost"));
    reset(); activate(); mock_queue_full = true; event full = {0}; enqueue(&full);
    CHECK(atomic_load(&fault) && !media_enabled); maintenance(0); CHECK(state.closing);
    reset(); maintenance(0); CHECK(!mock_dials && strstr(mock_json, "heartbeat"));
    reset(); state.call_known = state.setup_known = state.held_known = false;
    hf(ESP_HF_CLIENT_CONNECTION_STATE_EVT, ESP_HF_CLIENT_CONNECTION_STATE_SLC_CONNECTED);
    CHECK(!state.hf_ready);
    hf(ESP_HF_CLIENT_CIND_CALL_EVT, 0); hf(ESP_HF_CLIENT_CIND_CALL_SETUP_EVT, 0);
    CHECK(!state.hf_ready); hf(ESP_HF_CLIENT_CIND_CALL_HELD_EVT, 0); CHECK(state.hf_ready);
}
static void test_pcm_and_pairing(void)
{
    reset(); uint8_t incoming[240], outgoing[240]; memset(incoming, 42, sizeof(incoming));
    incoming_pcm(incoming, sizeof(incoming)); CHECK(to_server.count == 0 && outgoing_pcm(outgoing, sizeof(outgoing)) == 0);
    activate(); incoming_pcm(incoming, sizeof(incoming)); CHECK(to_server.count == 240 && to_phone.count == 0);
    outgoing_pcm(outgoing, sizeof(outgoing)); CHECK(outgoing[0] == 0 && outgoing[239] == 0);
    uint8_t wire[PCM_FRAME_BYTES]; memset(wire, 12, sizeof(wire));
    esp_websocket_event_data_t d = {.data_len = 300, .payload_len = 640, .op_code = 2,
                                   .data_ptr = (const char *)wire, .fin = true};
    websocket_event(NULL, NULL, WEBSOCKET_EVENT_DATA, &d); CHECK(to_phone.count == 0);
    d.data_len = 340; d.payload_offset = 300; d.data_ptr = (const char *)wire + 300;
    websocket_event(NULL, NULL, WEBSOCKET_EVENT_DATA, &d); CHECK(to_phone.count == 640);
    CHECK(outgoing_pcm(outgoing, sizeof(outgoing)) == 240 && outgoing[0] == 12);
    mute(); CHECK(!to_phone.count && !to_server.count);
    reset(); activate(); d.payload_offset = 0; d.payload_len = d.data_len = 639; d.data_ptr = (const char *)wire;
    websocket_event(NULL, NULL, WEBSOCKET_EVENT_DATA, &d); CHECK(atomic_load(&fault) && !media_enabled);
    reset(); activate(); hf(ESP_HF_CLIENT_AUDIO_STATE_EVT, ESP_HF_CLIENT_AUDIO_STATE_CONNECTED);
    incoming_pcm(incoming, sizeof(incoming)); CHECK(to_server.count == 480 && !to_phone.count);
    d.payload_offset = 0; d.payload_len = d.data_len = 640; d.data_ptr = (const char *)wire;
    websocket_event(NULL, NULL, WEBSOCKET_EVENT_DATA, &d); CHECK(to_phone.count == 320);
    CHECK(outgoing_pcm(outgoing, 120) == 120 && to_phone.count == 200);

    reset(); esp_bt_gap_cb_param_t gap = {0}; gap.cfm_req.bda[0] = 1;
    gap_callback(ESP_BT_GAP_CFM_REQ_EVT, &gap); CHECK(mock_confirmations == 0 && !state.pairing);
    event pair = {.type = EV_PAIR, .value = 123456}; handle_event(pair);
    event consent = {.type = EV_CONFIRM, .value = 999999}; handle_event(consent); CHECK(!mock_confirmations);
    consent.value = 123456; handle_event(consent); CHECK(mock_confirmations == 1 && !state.pairing);
    handle_event(pair); mock_now = 31000000; handle_event(consent); CHECK(mock_confirmations == 1);

    pcm_ring ring = {0}; uint8_t frame[640], read[640]; memset(frame, 7, sizeof(frame));
    for (int i = 0; i < 6; ++i) CHECK(pcm_push(&ring, frame, 640));
    CHECK(pcm_push(&ring, wire, 640) && ring.count == 640);
    CHECK(pcm_pop(&ring, read, 640) && read[0] == 12);
    CHECK(!pcm_pop(&ring, read, 2));
    pcm_resampler s = {0}; uint8_t dc[640], narrow[320], wide[640];
    for (int i = 0; i < 640; i += 2) { dc[i] = 0xe8; dc[i + 1] = 3; }
    CHECK(pcm_downsample(&s, dc, 640, narrow) == 320);
    CHECK(narrow[318] == 0xe8 && narrow[319] == 3);
    memset(&s, 0, sizeof(s)); CHECK(pcm_upsample(&s, narrow, 320, wide) == 640);
    CHECK(wide[638] == 0xe8 && wide[639] == 3);
    for (int i = 0; i < 640; i += 4) { dc[i] = 0x10; dc[i+1] = 0x27; dc[i+2] = 0xf0; dc[i+3] = 0xd8; }
    memset(&s, 0, sizeof(s)); pcm_downsample(&s, dc, 640, narrow);
    CHECK(narrow[318] == 0 && narrow[319] == 0);
    CHECK(valid_call_id(ID) && !valid_call_id("not-a-uuid"));
    CHECK(valid_e164("+15551234567") && !valid_e164("+1555\rATD+12") && !valid_e164(NULL));
}
static void test_invalid_states(void)
{
    const int codes[] = { ESP_HF_CLIENT_CONNECTION_STATE_EVT, ESP_HF_CLIENT_AUDIO_STATE_EVT,
        ESP_HF_CLIENT_CIND_CALL_EVT, ESP_HF_CLIENT_CIND_CALL_SETUP_EVT, ESP_HF_CLIENT_CIND_CALL_HELD_EVT,
        ESP_HF_CLIENT_CLCC_EVT, ESP_HF_CLIENT_AT_RESPONSE_EVT, ESP_HF_CLIENT_PROF_STATE_EVT, 9999 };
    for (unsigned i = 0; i < sizeof(codes) / sizeof(codes[0]); ++i) {
        reset(); activate();
        hf(codes[i], 9999);
        CHECK(!media_enabled && !state.active && !state.hf_ready && !state.call_id[0]);
        CHECK(mock_hangups == 0);
    }
    reset(); call_state(ID, (call_status)9999, NULL); CHECK(atomic_load(&fault) && !mock_json_size);
    reset(); event unknown = {.type = (event_type)9999}; handle_event(unknown);
    CHECK(atomic_load(&fault));
    reset(); esp_hf_client_cb_param_t hfp = {0}; hf_callback((esp_hf_client_cb_event_t)9999, &hfp);
    CHECK(atomic_load(&fault));
    reset(); hf_callback(ESP_HF_CLIENT_CIND_BATTERY_LEVEL_EVT, &hfp);
    CHECK(!atomic_load(&fault));
    reset(); esp_bt_gap_cb_param_t gap = {0}; gap_callback((esp_bt_gap_cb_event_t)9999, &gap);
    CHECK(atomic_load(&fault));
    reset(); gap_callback(ESP_BT_GAP_AUTH_CMPL_EVT, &gap); CHECK(!atomic_load(&fault));
    const char *invalid[] = { "null", "{}", "{", "{\"type\":\"dial\",\"callId\":\"not-a-uuid\"}",
        "{\"type\":\"future\",\"callId\":\"12345678-1234-4567-89ab-123456789abc\"}",
        "{\"type\":\"hangup\",\"callId\":\"12345678-1234-4567-89ab-123456789abc\"} junk" };
    for (unsigned i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i) {
        reset(); command(invalid[i]); CHECK(atomic_load(&fault) && !mock_dials);
    }
    reset(); command("{\"type\":\"hangup\",\"callId\":\"12345678-1234-4567-89ab-123456789abc\"}");
    CHECK(!mock_hangups && strstr(mock_json, "unknown_call"));
    reset(); esp_websocket_event_data_t data = {.op_code = 15};
    websocket_event(NULL, NULL, WEBSOCKET_EVENT_DATA, &data); CHECK(atomic_load(&fault));
    reset(); websocket_event(NULL, NULL, 9999, NULL); CHECK(atomic_load(&fault));
    reset(); websocket_event(NULL, NULL, WEBSOCKET_EVENT_BEFORE_CONNECT, NULL);
    websocket_event(NULL, NULL, WEBSOCKET_EVENT_BEGIN, NULL); CHECK(!atomic_load(&fault));
    activate(); websocket_event(NULL, NULL, WEBSOCKET_EVENT_CLOSED, NULL);
    CHECK(!media_enabled && !atomic_load(&online));
}
int main(void)
{
    test_call_control(); test_session_and_watchdog(); test_pcm_and_pairing(); test_invalid_states();
    printf("PASS: %u firmware lifecycle/audio assertions; no radio, calls, or flashing\n", checks);
    return 0;
}
