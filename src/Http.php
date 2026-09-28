<?php
// src/Http.php

declare(strict_types=1);

namespace Jamri;

/**
 * Shared HTTP helpers: security headers, JSON body decoding and JSON responses.
 * Keeping these in one place guarantees every API endpoint applies the same
 * baseline hardening.
 */
final class Http
{
    public static function securityHeaders(bool $json = true): void
    {
        if ($json) {
            header('Content-Type: application/json; charset=utf-8');
        }
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: DENY');
        header('Referrer-Policy: strict-origin-when-cross-origin');
        header('Permissions-Policy: geolocation=(), camera=(), microphone=(self)');
        header(
            "Content-Security-Policy: "
            . "default-src 'self'; "
            . "script-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; "
            . "style-src 'self' 'unsafe-inline'; "
            . "img-src 'self' data: https:; "
            . "media-src 'self' blob: data: https:; "
            . "connect-src 'self' ws: wss: https://www.youtube.com https://www.youtube-nocookie.com https://i.ytimg.com; "
            . "frame-src https://www.youtube.com https://www.youtube-nocookie.com; "
            . "object-src 'none'; "
            . "base-uri 'self'; "
            . "form-action 'self'"
        );
        header('Cross-Origin-Resource-Policy: same-site');
    }

    /** Decode the JSON request body, falling back to form-encoded POST data. */
    public static function input(): array
    {
        $raw = file_get_contents('php://input') ?: '';
        if ($raw !== '') {
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) {
                return $decoded;
            }
        }
        return $_POST;
    }

    public static function json(mixed $data, int $status = 200): void
    {
        http_response_code($status);
        echo json_encode($data, JSON_UNESCAPED_UNICODE);
        exit;
    }

    public static function error(string $message, int $status = 400, array $extra = []): void
    {
        self::json(array_merge(['success' => false, 'error' => $message], $extra), $status);
    }

    /** Best-effort client identity for rate limiting (never persisted raw). */
    public static function clientKey(string $deviceId = ''): string
    {
        if ($deviceId !== '') {
            return 'dev:' . $deviceId;
        }
        $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
        return 'ip:' . $ip;
    }
}