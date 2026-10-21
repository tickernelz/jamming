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
    private bool $dirty = false;

    public function __construct(?string $storageDir = null)
    {
        $this->storageDir = $storageDir ?? (dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data');
        $this->load();
    }

    /**
     * Restore buckets written by a previous PHP worker.
     *
     * HTTP endpoints run in a fresh process per request, so an in-memory-only
     * map meant every request started with an empty bucket and the limits never
     * triggered (room creation, chat, search, ...). The WS daemon is long-lived
     * and simply keeps its map in memory.
     */
    private function load(): void
    {
        $file = $this->storageFile();
        if (!is_file($file)) {
            return;
        }
        $raw = @file_get_contents($file);
        if (!is_string($raw) || $raw === '') {
            return;
        }
        // Guard against a corrupted/huge file turning into a memory problem.
        if (strlen($raw) > 512 * 1024) {
            @unlink($file);
            return;
        }
        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            @unlink($file);
            return;
        }
        $now = microtime(true);
        foreach ($decoded as $key => $bucket) {
            if (!is_string($key) || !is_array($bucket)) {
                continue;
            }
            $start = (float)($bucket['start'] ?? 0);
            $count = (int)($bucket['count'] ?? 0);
            // Drop entries that are already far past any window we use.
            if ($start <= 0 || $count <= 0 || ($now - $start) > 3600) {
                continue;
            }
            $this->buckets[$key] = ['start' => $start, 'count' => $count];
        }
    }

    private function storageFile(): string
    {
        return $this->storageDir . DIRECTORY_SEPARATOR . 'rate_limit.json';
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
            $this->dirty = true;
            $this->maybePersist();
            return true;
        }

        if ($bucket['count'] >= $limit) {
            return false;
        }

        $this->buckets[$key]['count']++;
        $this->dirty = true;
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
        // Persist on every change: PHP workers are per-request, so batching would
        // lose the increments that make the limit effective. The write is a single
        // small JSON blob with LOCK_EX and the map is compacted first.
        $this->gc();
        if (!is_dir($this->storageDir)) {
            @mkdir($this->storageDir, 0755, true);
        }
        $file = $this->storageFile();
        $payload = json_encode($this->buckets);
        if (!is_string($payload)) {
            return;
        }
        @file_put_contents($file, $payload, LOCK_EX);
        @chmod($file, 0600);
        $this->dirty = false;
    }
}
