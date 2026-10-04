idf_component_register(SRCS "gateway.c" "media.c" INCLUDE_DIRS "."
    REQUIRES bt esp_wifi esp_netif nvs_flash esp_event esp_timer json esp_websocket_client mbedtls)
