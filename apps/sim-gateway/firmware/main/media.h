#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define PCM_FRAME_BYTES 640
#define PCM_RING_BYTES (PCM_FRAME_BYTES * 6)
typedef struct {
    uint8_t bytes[PCM_RING_BYTES];
    size_t head, count;
} pcm_ring;
typedef struct {
    int16_t previous;
    int16_t history[7];
    unsigned cursor, phase;
} pcm_resampler;
void pcm_clear(pcm_ring *r);
bool pcm_push(pcm_ring *r, const uint8_t *data, size_t size);
bool pcm_pop(pcm_ring *r, uint8_t *data, size_t size);
size_t pcm_upsample(pcm_resampler *s, const uint8_t *in, size_t size, uint8_t *out);
size_t pcm_downsample(pcm_resampler *s, const uint8_t *in, size_t size, uint8_t *out);
bool valid_e164(const char *s);
bool valid_call_id(const char *s);
