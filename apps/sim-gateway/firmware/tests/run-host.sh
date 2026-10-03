#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${IDF_PATH:?Set IDF_PATH to an ESP-IDF v5.4.2 checkout}"
mkdir -p build/host
cc -std=c11 -O1 -g -Wall -Wextra -Werror -Wno-unused-function -Wno-unused-variable \
  -fsanitize=address,undefined -fno-omit-frame-pointer \
  -Itests -I"$IDF_PATH/components/bt/host/bluedroid/api/include/api" \
  -I"$IDF_PATH/components/esp_common/include" \
  -I"$IDF_PATH/components/json/cJSON" \
  tests/test_gateway.c main/media.c "$IDF_PATH/components/json/cJSON/cJSON.c" \
  -lm -o build/host/test_gateway
build/host/test_gateway
