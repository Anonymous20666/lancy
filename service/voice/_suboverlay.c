/* Fast libass-backed YUV420p subtitle overlay renderer loaded via dlopen(libass.so.9). */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct ass_image {
    int w;
    int h;
    int stride;
    unsigned char *bitmap;
    uint32_t color;
    int dst_x;
    int dst_y;
    struct ass_image *next;
    int type;
} ASS_Image;

typedef void *(*fn_library_init)(void);
typedef void (*fn_library_done)(void *);
typedef void (*fn_set_message_cb)(void *, void (*)(int, const char *, va_list, void *), void *);
typedef void *(*fn_renderer_init)(void *);
typedef void (*fn_renderer_done)(void *);
typedef void (*fn_set_frame_size)(void *, int, int);
typedef void (*fn_set_fonts)(void *, const char *, const char *, int, const char *, int);
typedef void *(*fn_read_memory)(void *, char *, size_t, const char *);
typedef void (*fn_free_track)(void *);
typedef ASS_Image *(*fn_render_frame)(void *, void *, long long, int *);

static void quiet_log_cb(int level, const char *fmt, va_list args, void *data) {
    (void)level;
    (void)fmt;
    (void)args;
    (void)data;
}

typedef struct SubCtx {
    void *dl;
    void *lib;
    void *renderer;
    void *track;
    void *hud_track;
    int width;
    int height;

    fn_library_init ass_library_init;
    fn_library_done ass_library_done;
    fn_set_message_cb ass_set_message_cb;
    fn_renderer_init ass_renderer_init;
    fn_renderer_done ass_renderer_done;
    fn_set_frame_size ass_set_frame_size;
    fn_set_fonts ass_set_fonts;
    fn_read_memory ass_read_memory;
    fn_free_track ass_free_track;
    fn_render_frame ass_render_frame;
} SubCtx;

static inline uint8_t clamp_u8(int v) {
    return (uint8_t)(v < 0 ? 0 : (v > 255 ? 255 : v));
}

SubCtx *sub_create(int width, int height, const char *font_path) {
    if (width <= 0 || height <= 0) return NULL;
    void *dl = dlopen("libass.so.9", RTLD_LAZY);
    if (!dl) return NULL;

    SubCtx *ctx = (SubCtx *)calloc(1, sizeof(SubCtx));
    if (!ctx) {
        dlclose(dl);
        return NULL;
    }
    ctx->dl = dl;
    ctx->width = width;
    ctx->height = height;

    ctx->ass_library_init = (fn_library_init)dlsym(dl, "ass_library_init");
    ctx->ass_library_done = (fn_library_done)dlsym(dl, "ass_library_done");
    ctx->ass_set_message_cb = (fn_set_message_cb)dlsym(dl, "ass_set_message_cb");
    ctx->ass_renderer_init = (fn_renderer_init)dlsym(dl, "ass_renderer_init");
    ctx->ass_renderer_done = (fn_renderer_done)dlsym(dl, "ass_renderer_done");
    ctx->ass_set_frame_size = (fn_set_frame_size)dlsym(dl, "ass_set_frame_size");
    ctx->ass_set_fonts = (fn_set_fonts)dlsym(dl, "ass_set_fonts");
    ctx->ass_read_memory = (fn_read_memory)dlsym(dl, "ass_read_memory");
    ctx->ass_free_track = (fn_free_track)dlsym(dl, "ass_free_track");
    ctx->ass_render_frame = (fn_render_frame)dlsym(dl, "ass_render_frame");

    if (!ctx->ass_library_init || !ctx->ass_library_done || !ctx->ass_renderer_init ||
        !ctx->ass_renderer_done || !ctx->ass_set_frame_size || !ctx->ass_set_fonts ||
        !ctx->ass_read_memory || !ctx->ass_free_track || !ctx->ass_render_frame) {
        dlclose(dl);
        free(ctx);
        return NULL;
    }

    ctx->lib = ctx->ass_library_init();
    if (!ctx->lib) {
        dlclose(dl);
        free(ctx);
        return NULL;
    }
    if (ctx->ass_set_message_cb) {
        ctx->ass_set_message_cb(ctx->lib, quiet_log_cb, NULL);
    }

    ctx->renderer = ctx->ass_renderer_init(ctx->lib);
    if (!ctx->renderer) {
        ctx->ass_library_done(ctx->lib);
        dlclose(dl);
        free(ctx);
        return NULL;
    }

    ctx->ass_set_frame_size(ctx->renderer, width, height);
    const char *fallback_font = (font_path && font_path[0]) ? font_path : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
    ctx->ass_set_fonts(ctx->renderer, fallback_font, "DejaVu Sans", 1, NULL, 1);
    return ctx;
}

static int _load_ass_slot(SubCtx *ctx, void **slot, const char *data, size_t len) {
    if (!ctx || !slot) return -1;
    if (*slot) {
        ctx->ass_free_track(*slot);
        *slot = NULL;
    }
    if (!data || len == 0) return 0;
    char *copy = (char *)malloc(len + 1);
    if (!copy) return -1;
    memcpy(copy, data, len);
    copy[len] = '\0';
    *slot = ctx->ass_read_memory(ctx->lib, copy, len, NULL);
    free(copy);
    return *slot ? 0 : -1;
}

int sub_load_ass_mem(SubCtx *ctx, const char *data, size_t len) {
    return ctx ? _load_ass_slot(ctx, &ctx->track, data, len) : -1;
}

int sub_load_hud_ass_mem(SubCtx *ctx, const char *data, size_t len) {
    return ctx ? _load_ass_slot(ctx, &ctx->hud_track, data, len) : -1;
}

void sub_dim_yuv420(uint8_t *yuv, int width, int height, int y_factor_256) {
    if (!yuv || width <= 0 || height <= 0) return;
    int factor = y_factor_256 < 64 ? 64 : (y_factor_256 > 256 ? 256 : y_factor_256);
    if (factor >= 256) return;
    size_t n_y = (size_t)width * (size_t)height;
    for (size_t i = 0; i < n_y; i++) {
        int y = (int)yuv[i];
        int scaled = 16 + (((y - 16) * factor) >> 8);
        yuv[i] = clamp_u8(scaled < 16 ? 16 : scaled);
    }
}

static int _render_track_yuv420(SubCtx *ctx, void *track, uint8_t *yuv, int width, int height, long long pts_ms) {
    if (!ctx || !track || !yuv || width <= 0 || height <= 0) return 0;
    if (width != ctx->width || height != ctx->height) {
        ctx->width = width;
        ctx->height = height;
        ctx->ass_set_frame_size(ctx->renderer, width, height);
    }

    int detect_change = 0;
    ASS_Image *img = ctx->ass_render_frame(ctx->renderer, track, pts_ms, &detect_change);
    if (!img) return 0;

    int cw = width >> 1;
    int ch = height >> 1;
    uint8_t *y_plane = yuv;
    uint8_t *u_plane = yuv + (size_t)width * (size_t)height;
    uint8_t *v_plane = u_plane + (size_t)cw * (size_t)ch;

    int drawn = 0;
    for (ASS_Image *p = img; p; p = p->next) {
        if (!p->bitmap || p->w <= 0 || p->h <= 0) continue;

        uint32_t c = p->color;
        int alpha_col = 255 - (int)(c & 0xFFu);
        if (alpha_col <= 0) continue;

        int r = (int)((c >> 24) & 0xFFu);
        int g = (int)((c >> 16) & 0xFFu);
        int b = (int)((c >> 8) & 0xFFu);

        int yy = clamp_u8(16 + ((66 * r + 129 * g + 25 * b + 128) >> 8));
        int uu = clamp_u8(128 + ((-38 * r - 74 * g + 112 * b + 128) >> 8));
        int vv = clamp_u8(128 + ((112 * r - 94 * g - 18 * b + 128) >> 8));

        int x0 = p->dst_x < 0 ? 0 : p->dst_x;
        int y0 = p->dst_y < 0 ? 0 : p->dst_y;
        int x1 = p->dst_x + p->w;
        if (x1 > width) x1 = width;
        int y1 = p->dst_y + p->h;
        if (y1 > height) y1 = height;
        if (x0 >= x1 || y0 >= y1) continue;

        drawn = 1;
        for (int py = y0; py < y1; py++) {
            const uint8_t *src = p->bitmap + (size_t)(py - p->dst_y) * (size_t)p->stride;
            uint8_t *ydst = y_plane + (size_t)py * (size_t)width;
            for (int px = x0; px < x1; px++) {
                uint8_t k = src[px - p->dst_x];
                if (!k) continue;
                int a = (k * alpha_col + 127) / 255;
                if (a <= 0) continue;
                if (a >= 255) {
                    ydst[px] = (uint8_t)yy;
                } else {
                    int inv = 255 - a;
                    ydst[px] = (uint8_t)((ydst[px] * inv + yy * a + 127) / 255);
                }
            }
        }

        int cy0 = y0 >> 1;
        int cx0 = x0 >> 1;
        int cy1 = (y1 + 1) >> 1;
        int cx1 = (x1 + 1) >> 1;
        if (cy1 > ch) cy1 = ch;
        if (cx1 > cw) cx1 = cw;

        for (int cy = cy0; cy < cy1; cy++) {
            int py0 = cy << 1;
            int py1 = py0 + 1;
            const uint8_t *s0 = (py0 >= y0 && py0 < y1) ? (p->bitmap + (size_t)(py0 - p->dst_y) * (size_t)p->stride) : NULL;
            const uint8_t *s1 = (py1 >= y0 && py1 < y1) ? (p->bitmap + (size_t)(py1 - p->dst_y) * (size_t)p->stride) : NULL;
            uint8_t *udst = u_plane + (size_t)cy * (size_t)cw;
            uint8_t *vdst = v_plane + (size_t)cy * (size_t)cw;
            for (int cx = cx0; cx < cx1; cx++) {
                int px0 = cx << 1;
                int px1 = px0 + 1;
                int sum_k = 0;
                if (s0) {
                    if (px0 >= x0 && px0 < x1) sum_k += s0[px0 - p->dst_x];
                    if (px1 >= x0 && px1 < x1) sum_k += s0[px1 - p->dst_x];
                }
                if (s1) {
                    if (px0 >= x0 && px0 < x1) sum_k += s1[px0 - p->dst_x];
                    if (px1 >= x0 && px1 < x1) sum_k += s1[px1 - p->dst_x];
                }
                if (!sum_k) continue;
                int avg_k = (sum_k + 2) >> 2;
                int a = (avg_k * alpha_col + 127) / 255;
                if (a <= 0) continue;
                if (a >= 255) {
                    udst[cx] = (uint8_t)uu;
                    vdst[cx] = (uint8_t)vv;
                } else {
                    int inv = 255 - a;
                    udst[cx] = (uint8_t)((udst[cx] * inv + uu * a + 127) / 255);
                    vdst[cx] = (uint8_t)((vdst[cx] * inv + vv * a + 127) / 255);
                }
            }
        }
    }
    return drawn;
}

int sub_render_yuv420(SubCtx *ctx, uint8_t *yuv, int width, int height, long long pts_ms) {
    return ctx ? _render_track_yuv420(ctx, ctx->track, yuv, width, height, pts_ms) : 0;
}

int sub_render_hud_yuv420(SubCtx *ctx, uint8_t *yuv, int width, int height, long long pts_ms) {
    return ctx ? _render_track_yuv420(ctx, ctx->hud_track, yuv, width, height, pts_ms) : 0;
}

void sub_destroy(SubCtx *ctx) {
    if (!ctx) return;
    if (ctx->track) {
        ctx->ass_free_track(ctx->track);
        ctx->track = NULL;
    }
    if (ctx->hud_track) {
        ctx->ass_free_track(ctx->hud_track);
        ctx->hud_track = NULL;
    }
    if (ctx->renderer) {
        ctx->ass_renderer_done(ctx->renderer);
        ctx->renderer = NULL;
    }
    if (ctx->lib) {
        ctx->ass_library_done(ctx->lib);
        ctx->lib = NULL;
    }
    if (ctx->dl) {
        dlclose(ctx->dl);
        ctx->dl = NULL;
    }
    free(ctx);
}
