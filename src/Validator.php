<?php
// src/Validator.php

declare(strict_types=1);

namespace Jamri;

/**
 * Centralised input sanitation & validation helpers.
 *
 * Jamri is an anonymous "just-for-fun" jamming platform: there are no accounts
 * and no personal data. Validation therefore focuses on protecting every user
 * in a room (anti-XSS, anti-DoS, data integrity) rather than on identity
 * verification.
 */
final class Validator
{
    public const MAX_NICKNAME_LEN = 25;
    public const MAX_EMOJI_LEN = 8;
    public const MAX_ROOM_NAME_LEN = 60;
    public const MAX_PASSCODE_LEN = 32;
    public const MAX_CHAT_LEN = 300;
    public const MAX_TITLE_LEN = 160;
    public const MAX_CHANNEL_LEN = 120;
    public const MAX_URL_LEN = 512;
    public const MAX_SOUND_TITLE_LEN = 30;
    public const MAX_DEVICE_ID_LEN = 128;
    public const MAX_ROOM_ID_LEN = 64;

    /** Default avatar used whenever an emoji is missing or rejected. */
    public const DEFAULT_EMOJI = '🎧';

    /**
     * Strip control characters (incl. null bytes / newlines) and enforce a max
     * length in a Unicode-safe way. This is the first line of defence for every
     * free-text field that later gets broadcast or stored.
     */
    public static function clean(?string $value, int $maxLen): string
    {
        $value = (string)$value;
        // Remove ASCII control chars except a normal space; keep multibyte intact.
        $value = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $value) ?? '';
        $value = trim($value);
        if (mb_strlen($value, 'UTF-8') > $maxLen) {
            $value = mb_substr($value, 0, $maxLen, 'UTF-8');
        }
        return $value;
    }

    public static function nickname(?string $value, string $fallback = 'Kawan Jamming'): string
    {
        $v = self::clean($value, self::MAX_NICKNAME_LEN);
        return $v !== '' ? $v : $fallback;
    }

    /**
     * Accept only a single grapheme cluster (emoji or a short symbol sequence).
     * Anything containing HTML metacharacters or emoji-ZWJ bombs is rejected and
     * replaced with the safe default. Length is capped to a few code points.
     */
    public static function emoji(?string $value): string
    {
        $v = trim((string)$value);
        if ($v === '' || mb_strlen($v, 'UTF-8') > self::MAX_EMOJI_LEN) {
            return self::DEFAULT_EMOJI;
        }
        // Reject anything that could break out of an HTML/JS context.
        if (preg_match('/[<>&"\'\\\\`\/{}()\[\]=;:]/u', $v)) {
            return self::DEFAULT_EMOJI;
        }
        // Reject control chars / whitespace-only.
        if (preg_match('/[\x00-\x1F\x7F\s]/u', $v)) {
            return self::DEFAULT_EMOJI;
        }
        return $v;
    }

    public static function roomName(?string $value): string
    {
        return self::clean($value, self::MAX_ROOM_NAME_LEN);
    }

    public static function passcode(?string $value): string
    {
        return self::clean($value, self::MAX_PASSCODE_LEN);
    }

    public static function chatMessage(?string $value): string
    {
        return self::clean($value, self::MAX_CHAT_LEN);
    }

    public static function deviceId(?string $value): string
    {
        $v = self::clean($value, self::MAX_DEVICE_ID_LEN);
        // device_id is a client-generated opaque token: allow only safe chars.
        return preg_replace('/[^A-Za-z0-9_.\-]/', '', $v) ?? '';
    }

    public static function roomId(?string $value): string
    {
        $v = self::clean($value, self::MAX_ROOM_ID_LEN);
        // UUID style: hex + dashes (stored ids are UUID v4).
        return preg_replace('/[^A-Za-z0-9\-]/', '', $v) ?? '';
    }

    /** YouTube video id: exactly 11 url-safe characters. */
    public static function youtubeId(?string $value): string
    {
        $v = trim((string)$value);
        return preg_match('/^[A-Za-z0-9_-]{11}$/', $v) ? $v : '';
    }

    /**
     * Extract a YouTube playlist id from either a raw id or any playlist URL.
     * Returns '' when nothing valid is found.
     */
    public static function playlistId(?string $value): string
    {
        $v = trim((string)$value);
        if ($v === '' || strlen($v) > 300) {
            return '';
        }

        // Pull `list=` out of a full URL when present.
        if (preg_match('/[?&]list=([A-Za-z0-9_-]+)/', $v, $m)) {
            $v = $m[1];
        }

        // Allow a "VL" prefixed browse id and normalise it away.
        if (str_starts_with($v, 'VL')) {
            $v = substr($v, 2);
        }

        // YouTube playlist ids are alphanumeric with - and _ (usually 13-42 chars).
        return preg_match('/^[A-Za-z0-9_-]{10,60}$/', $v) ? $v : '';
    }

    /** Clamp the requested playlist import size. */
    public static function playlistLimit(mixed $value): int
    {
        $n = (int)$value;
        if ($n <= 0) {
            return 50;
        }
        return min($n, 150);
    }

    public static function title(?string $value, string $fallback = 'Untitled Track'): string
    {
        $v = self::clean($value, self::MAX_TITLE_LEN);
        return $v !== '' ? $v : $fallback;
    }

    public static function channel(?string $value, string $fallback = 'YouTube'): string
    {
        $v = self::clean($value, self::MAX_CHANNEL_LEN);
        return $v !== '' ? $v : $fallback;
    }

    public static function duration(mixed $value): int
    {
        $n = (int)$value;
        if ($n < 0) {
            return 0;
        }
        // 24h ceiling keeps the queue UI sane and blocks absurd values.
        return min($n, 86400);
    }

    /**
     * Only allow track artwork from YouTube's own image hosts. This closes the
     * stored-XSS vector that flowed through `<img src="...">` rendering.
     */
    public static function thumbnailUrl(?string $value): string
    {
        $v = trim((string)$value);
        if ($v === '' || strlen($v) > self::MAX_URL_LEN) {
            return '';
        }
        if (str_starts_with($v, '//')) {
            $v = 'https:' . $v;
        }
        $parts = parse_url($v);
        if (!is_array($parts) || empty($parts['host'])) {
            return '';
        }
        if (strtolower((string)($parts['scheme'] ?? '')) !== 'https') {
            return '';
        }
        $host = strtolower((string)$parts['host']);
        $allowed = ['i.ytimg.com', 'img.youtube.com', 'yt3.ggpht.com', 'i9.ytimg.com'];
        if (!in_array($host, $allowed, true)) {
            return '';
        }
        // Never echo back a value containing HTML metacharacters.
        if (preg_match('/[<>"\'\\\\`\s]/', $v)) {
            return '';
        }
        return $v;
    }

    /** Normalise an incoming track payload from any untrusted source. */
    public static function track(array $track): ?array
    {
        $ytId = self::youtubeId($track['youtube_id'] ?? null);
        if ($ytId === '') {
            return null;
        }

        $out = [
            'youtube_id' => $ytId,
            'title' => self::title($track['title'] ?? null),
            'channel' => self::channel($track['channel'] ?? null),
            'duration_seconds' => self::duration($track['duration_seconds'] ?? $track['duration'] ?? 0),
            'thumbnail_url' => self::thumbnailUrl($track['thumbnail_url'] ?? $track['thumbnail'] ?? ''),
        ];

        // Preserve a trusted integer queue/playlist id when present.
        if (isset($track['id'])) {
            $out['id'] = (int)$track['id'];
        }
        return $out;
    }

    /** Whitelist loop modes. */
    public static function loopMode(mixed $mode): string
    {
        $m = (string)$mode;
        return in_array($m, ['off', 'one', 'all'], true) ? $m : 'off';
    }

    /** Clamp a playback position to a sane range. */
    public static function position(mixed $value): float
    {
        $n = (float)$value;
        if (!is_finite($n) || $n < 0) {
            return 0.0;
        }
        return min($n, 86400.0);
    }
}
