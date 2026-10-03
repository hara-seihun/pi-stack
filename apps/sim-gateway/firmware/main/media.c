#include "media.h"
#include <string.h>

void pcm_clear(pcm_ring *r) { r->head = r->count = 0; }

bool pcm_push(pcm_ring *r, const uint8_t *data, size_t size)
{
    if (size > PCM_RING_BYTES) return false;
    if (r->count + size > PCM_RING_BYTES) pcm_clear(r);
    for (size_t i = 0; i < size; ++i)
        r->bytes[(r->head + r->count + i) % PCM_RING_BYTES] = data[i];
    r->count += size;
    return true;
}

bool pcm_pop(pcm_ring *r, uint8_t *data, size_t size)
{
    if (size > r->count) return false;
    for (size_t i = 0; i < size; ++i)
        data[i] = r->bytes[(r->head + i) % PCM_RING_BYTES];
    r->head = (r->head + size) % PCM_RING_BYTES;
    r->count -= size;
    return true;
}

static int16_t read_sample(const uint8_t *p)
{
    return (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}
static void write_sample(uint8_t *p, int16_t sample)
{
    p[0] = (uint16_t)sample & 255;
    p[1] = (uint16_t)sample >> 8;
}

size_t pcm_upsample(pcm_resampler *s, const uint8_t *in, size_t size, uint8_t *out)
{
    for (size_t i = 0; i + 1 < size; i += 2) {
        int16_t v = read_sample(in + i);
        write_sample(out + i * 2, ((int32_t)s->previous + v) / 2);
        write_sample(out + i * 2 + 2, v);
        s->previous = v;
    }
    return (size & ~(size_t)1) * 2;
}

size_t pcm_downsample(pcm_resampler *s, const uint8_t *in, size_t size, uint8_t *out)
{
    static const int coeff[7] = {-1, 0, 9, 16, 9, 0, -1};
    size_t written = 0;
    for (size_t i = 0; i + 1 < size; i += 2) {
        s->history[s->cursor] = read_sample(in + i);
        s->cursor = (s->cursor + 1) % 7;
        s->phase ^= 1;
        if (s->phase) continue;
        int32_t value = 0;
        for (unsigned k = 0; k < 7; ++k)
            value += coeff[k] * s->history[(s->cursor + k) % 7];
        value /= 32;
        if (value > 32767) value = 32767;
        if (value < -32768) value = -32768;
        write_sample(out + written, value);
        written += 2;
    }
    return written;
}

bool valid_e164(const char *s)
{
    if (!s || s[0] != '+' || s[1] < '1' || s[1] > '9') return false;
    size_t n = strlen(s);
    if (n < 8 || n > 16) return false;
    for (size_t i = 2; i < n; ++i)
        if (s[i] < '0' || s[i] > '9') return false;
    return true;
}
bool valid_call_id(const char *s)
{
    if (!s || strlen(s) != 36) return false;
    for (unsigned i = 0; i < 36; ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (s[i] != '-') return false;
        } else if (!((s[i] >= '0' && s[i] <= '9') ||
                     (s[i] >= 'a' && s[i] <= 'f') ||
                     (s[i] >= 'A' && s[i] <= 'F'))) return false;
    }
    return true;
}
