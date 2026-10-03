# Firmware build receipt

Recorded **2026-10-03 03:06 UTC** on `kenan-server` (Ubuntu, x86-64). This is compile/host-test proof only. No USB device was attached, no firmware flashed, no Bluetooth pairing performed, no cellular call placed and no hardware purchased/delivered.

## Toolchain and inputs

- ESP-IDF tag **v5.4.2**, exact commit `f5c3654a1c2d2a01f7f67def7a0dc48e691f63c0`, build checkout `/tmp/esp-idf-5.4.2`.
- Xtensa GCC **14.2.0**, `crosstool-NG esp-14.2.0_20241119`; tools under `/home/kenan/.espressif`.
- IDF Python environment `idf5.4_py3.14_env`; esptool **4.12.0**.
- Target original **esp32**, 4 MB flash; app version `0.1.0`.
- Managed WebSocket dependency **1.4.0**, locked in `dependencies.lock`.
- `sdkconfig.defaults` plus `tests/sdkconfig.compile`: explicitly **nonsecret, fake** network/device/token fields. This forces the compiler to retain and link the full HFP/Wi-Fi code. Building with empty owner defaults alone produces an inert, optimized-down image and is not the full-radio proof.

## Commands and observed results

From this firmware directory, after exporting IDF:

```bash
./tests/run-host.sh
idf.py -B build/compile-proof -D SDKCONFIG=build/compile-proof.sdkconfig \
  -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;tests/sdkconfig.compile' build
idf.py -B build/compile-proof size
sha256sum build/compile-proof/kenan_sim_gateway.bin
```

Host GCC with `-Wall -Wextra -Werror`, AddressSanitizer and UndefinedBehaviorSanitizer:

```text
PASS: 77 firmware lifecycle/audio assertions; no radio, calls, or flashing
```

The host run uses the production implementation, real IDF Bluetooth API types, real cJSON and mocked transport/radio effects. It covers owned call answer+identity+SCO gating, busy/foreign/incoming call suppression, duplicate dial IDs, E.164 injection rejection, physical-end acknowledgement, disconnect/new-session clearing and no redial, stale epoch commands, local deadline, unconfirmed hangup, identity timeout, queue overflow, initial indicator readiness, heartbeat, HCI directions/no-loopback, CVSD and mSBC conversion paths, 640-byte framing/chunk assembly, invalid frame sizes, manual allowlisted consent, bounded rings, FIR DC/Nyquist response and validators. Captured host output: [tests/host-result.txt](tests/host-result.txt).

Final cross-compile/link output:

```text
Building C object esp-idf/main/CMakeFiles/__idf_main.dir/media.c.obj
Building C object esp-idf/main/CMakeFiles/__idf_main.dir/gateway.c.obj
Linking CXX executable kenan_sim_gateway.elf
Successfully created esp32 image.
kenan_sim_gateway.bin binary size 0x144150 bytes.
Smallest app partition is 0x177000 bytes.
0x32eb0 bytes (14%) free.
Project build complete.
```

Full image: **1,327,440 bytes**, SHA-256:

```text
b122224d9add8572aefaed35f44bf08099728eef67ced59d9cfa8435e20679ff
```

IDF size summary: flash code 946,418 B; flash data 236,000 B; IRAM 122,202 B used / 131,072 B (8,870 B free); linker DRAM 76,408 B used / 124,580 B (48,172 B free). This is link-time usage, not a runtime heap/stack measurement. Runtime radio/TLS allocation must still be checked on hardware.

Generated config confirmed:

```text
CONFIG_BT_HFP_AUDIO_DATA_PATH_HCI=y
CONFIG_BTDM_CTRL_BR_EDR_SCO_DATA_PATH_HCI=y
CONFIG_BT_HFP_WBS_ENABLE=y
CONFIG_ESP_COEX_SW_COEXIST_ENABLE=y
CONFIG_BTDM_CTRL_PINNED_TO_CORE=1
CONFIG_BT_BLUEDROID_PINNED_TO_CORE=1
CONFIG_ESP_WIFI_TASK_PINNED_TO_CORE_0=y
```

The fixture binary stays in the ignored build directory, not in source control, and **must not be flashed** as an owner's device.

## Hardware acceptance still open

Use an authorized owner's real provisioned original ESP32 and phone. Confirm numeric pairing, idle readiness, CVSD/mSBC codec negotiation, matching outgoing CLCC identity, no media before answer+SCO, two-way speech/no loopback, coexistence stability, runtime heap/stack margins, deadline and physical-end reports. Unplug network mid-call and establish that the owned cellular call actually ends; separately confirm a local/incoming unrelated phone call is neither captured nor hung up. If CLCC identity is absent/mismatched or HFP drops before hangup is confirmed, the firmware reports uncertainty and deliberately does not claim cellular termination.
