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
        header('Content-Security-Policy: ' . self::contentSecurityPolicy());
        header('Cross-Origin-Resource-Policy: same-site');
    }

    public static function contentSecurityPolicy(): string
    {
        return "default-src 'self'; "
            . "script-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; "
            . "style-src 'self' 'unsafe-inline'; "
            . "img-src 'self' data: https:; "
            . "media-src 'self' blob: data: https:; "
            . "connect-src 'self' " . self::socketSource() . 'https://www.youtube.com https://www.youtube-nocookie.com https://i.ytimg.com; '
            . "frame-src https://www.youtube.com https://www.youtube-nocookie.com; "
            . "object-src 'none'; "
            . "base-uri 'self'; "
            . "form-action 'self'";
    }

    /** The one WebSocket origin the page may open: wss://<host>/ws over HTTPS, ws://<host>:<ws_port> for local HTTP. */
    private static function socketSource(): string
    {
        $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
        if (preg_match('/^([a-z0-9.-]+)(:\d{1,5})?$/', $host, $m) !== 1) {
            return '';
        }
        if (self::isHttps()) {
            return "wss://{$host} ";
        }
        $config = require dirname(__DIR__) . '/config/app.php';
        return "ws://{$m[1]}:" . (int)$config['ws_port'] . ' ';
    }

    private static function isHttps(): bool
    {
        return ($_SERVER['HTTPS'] ?? '') !== '' && ($_SERVER['HTTPS'] ?? '') !== 'off';
    }

    /** Refuse bodies a cross-site page can send: non-JSON types, or a foreign Sec-Fetch-Site or Origin. */
    public static function requireSameOriginJson(): void
    {
        $site = (string)($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '');
        if ($site !== '' && $site !== 'same-origin') {
            self::error('cross_site_request', 403);
        }
        $origin = (string)($_SERVER['HTTP_ORIGIN'] ?? '');
        if ($origin !== '') {
            $parts = parse_url($origin);
            $authority = isset($parts['host']) ? $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '') : '';
            if ($authority === '' || strcasecmp($authority, (string)($_SERVER['HTTP_HOST'] ?? '')) !== 0) {
                self::error('cross_site_request', 403);
            }
        }
        $type = strtolower(trim(explode(';', (string)($_SERVER['CONTENT_TYPE'] ?? ''))[0]));
        if ($type !== 'application/json') {
            self::error('Content-Type harus application/json.', 415);
        }
    }

    public const SESSION_COOKIE = 'jamri_session';
    public const MAX_BODY_BYTES = 16384;

    /** Decode a same-origin JSON request body of at most $maxBytes. */
    public static function input(int $maxBytes = self::MAX_BODY_BYTES): array
    {
        self::requireSameOriginJson();
        if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > $maxBytes) {
            self::error('Request terlalu besar.', 413);
        }
        $raw = (string)file_get_contents('php://input', false, null, 0, $maxBytes + 1);
        if (strlen($raw) > $maxBytes) {
            self::error('Request terlalu besar.', 413);
        }
        if ($raw === '') {
            return [];
        }
        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            self::error('Body JSON tidak valid.', 400);
        }
        return $decoded;
    }

    public static function json(mixed $data, int $status = 200): never
    {
        http_response_code($status);
        echo json_encode($data, JSON_UNESCAPED_UNICODE);
        exit;
    }

    public static function error(string $message, int $status = 400, array $extra = []): never
    {
        self::json(array_merge(['success' => false, 'error' => $message], $extra), $status);
    }

    public static function currentUser(UserManager $users): ?array
    {
        $token = $_COOKIE[self::SESSION_COOKIE] ?? null;
        return $users->userForToken(is_string($token) ? $token : null);
    }

    /** @return array{device_id: string, nickname: string, emoji: string} */
    public static function requireUser(UserManager $users): array
    {
        $user = self::currentUser($users);
        if ($user === null) {
            self::error('session_required', 401, ['message' => 'Sesi tidak ditemukan. Muat ulang halaman lalu isi profil.']);
        }
        return $user;
    }

    public static function startSession(string $token): void
    {
        setcookie(self::SESSION_COOKIE, $token, [
            'expires' => time() + 365 * 86400,
            'path' => '/',
            'secure' => self::isHttps(),
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
    }

    /** Rate-limit identity of the calling network (never persisted raw). */
    public static function clientKey(): string
    {
        return 'ip:' . self::networkKey((string)($_SERVER['REMOTE_ADDR'] ?? ''));
    }

    /** IPv4 address as-is, IPv6 reduced to its /64 so one host cannot rotate through its prefix. */
    public static function networkKey(string $ip): string
    {
        $packed = @inet_pton(trim($ip));
        if ($packed === false) {
            return 'unknown';
        }
        if (strlen($packed) === 4) {
            return inet_ntop($packed);
        }
        if (str_starts_with($packed, str_repeat("\0", 10) . "\xff\xff")) {
            return inet_ntop(substr($packed, 12));
        }
        return inet_ntop(substr($packed, 0, 8) . str_repeat("\0", 8)) . '/64';
    }
}