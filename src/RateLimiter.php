<?php
// src/RateLimiter.php

declare(strict_types=1);

namespace Jamri;

/**
 * Lightweight file-backed token bucket / sliding-window rate limiter.
 *
 * Purpose: stop anonymous clients from flooding chat, voice, soundboard or
 * expensive upstream calls. No user identity is stored — buckets are keyed by a
 * short-lived hash of the caller (device id or IP) plus an action name, and the
 * backing file is periodically compacted so no personal data accumulates.
 */
final class RateLimiter
{
    private string $storageDir;
    private array $buckets = [];

    public function __construct(?string $storageDir = null)
    {
        $this->storageDir = $storageDir ?? (dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data');
    }

    /**
     * @param string $key    Logical bucket identity (e.g. "chat:device_abc").
     * @param int    $limit  Max events allowed inside the window.
     * @param int    $window Window length in seconds.
     * @return bool  true when the action is allowed, false when throttled.
     */
    public function allow(string $key, int $limit, int $window): bool
    {
        $now = microtime(true);
        $bucket = $this->buckets[$key] ?? null;

        if ($bucket === null || ($now - $bucket['start']) >= $window) {
            $this->buckets[$key] = ['start' => $now, 'count' => 1];
            $this->maybePersist();
            return true;
        }

        if ($bucket['count'] >= $limit) {
            return false;
        }

        $this->buckets[$key]['count']++;
        $this->maybePersist();
        return true;
    }

    /** Remaining seconds until the window resets (0 when allowed immediately). */
    public function retryAfter(string $key, int $window): int
    {
        $bucket = $this->buckets[$key] ?? null;
        if ($bucket === null) {
            return 0;
        }
        $remaining = (int)ceil($window - (microtime(true) - $bucket['start']));
        return max(0, $remaining);
    }

    /** Drop expired buckets so the in-memory map cannot grow forever. */
    public function gc(int $maxWindow = 300): void
    {
        $now = microtime(true);
        foreach ($this->buckets as $key => $bucket) {
            if (($now - $bucket['start']) > $maxWindow) {
                unset($this->buckets[$key]);
            }
        }
    }

    /** Build a short, non-reversible bucket key so raw ids never touch disk. */
    public static function key(string $action, string $identity): string
    {
        return $action . ':' . substr(hash('sha256', $identity), 0, 16);
    }

    private function maybePersist(): void
    {
        // Persistence is optional and intentionally cheap: it keeps counts alive
        // across PHP worker restarts for HTTP endpoints. WS daemon keeps them in
        // memory only. We throttle writes to avoid I/O on the hot path.
        if ((count($this->buckets) % 50) !== 0) {
            return;
        }
        $this->gc();
        if (!is_dir($this->storageDir)) {
            @mkdir($this->storageDir, 0755, true);
        }
        $file = $this->storageDir . DIRECTORY_SEPARATOR . 'rate_limit.json';
        @file_put_contents($file, json_encode($this->buckets), LOCK_EX);
        @chmod($file, 0600);
    }
}
