<?php

declare(strict_types=1);

namespace Jamri;

use Closure;
use PDO;
use PDOException;

/** Fixed-window rate limiter: shared across PHP workers through a SQLite store, or held in memory without one. */
final class RateLimiter
{
    private const SQLITE_CORRUPT = 11;
    private const SQLITE_NOTADB = 26;

    private array $buckets = [];
    private Closure $clock;

    public function __construct(private ?PDO $pdo = null, ?Closure $clock = null)
    {
        $this->clock = $clock ?? static fn (): float => microtime(true);
    }

    /** Limiter shared by all PHP workers, kept in its own SQLite file in the data directory. */
    public static function shared(): self
    {
        return new self(self::openStore(Database::dataDir() . DIRECTORY_SEPARATOR . 'rate_limits.sqlite'));
    }

    /** Open the bucket store without fsync; a store an OS crash left unreadable is recreated empty. */
    public static function openStore(string $path): PDO
    {
        try {
            return self::connectStore($path);
        } catch (PDOException $e) {
            if (!in_array($e->errorInfo[1] ?? null, [self::SQLITE_CORRUPT, self::SQLITE_NOTADB], true)) {
                throw $e;
            }
            error_log('[RateLimiter] recreating unreadable store ' . $path . ': ' . $e->getMessage());
            @unlink($path);
            @unlink($path . '-journal');
            return self::connectStore($path);
        }
    }

    private static function connectStore(string $path): PDO
    {
        $pdo = new PDO('sqlite:' . $path);
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = OFF;');
        if ((int)$pdo->query('PRAGMA user_version')->fetchColumn() !== 1) {
            $pdo->exec('CREATE TABLE IF NOT EXISTS rate_limits (
                bucket TEXT PRIMARY KEY,
                window_start REAL NOT NULL,
                hits INTEGER NOT NULL,
                window_seconds INTEGER NOT NULL
            ); PRAGMA user_version = 1;');
        }
        return $pdo;
    }

    /** Count one event; false once more than $limit events fall inside the current $window seconds. */
    public function allow(string $key, int $limit, int $window): bool
    {
        $now = ($this->clock)();
        if ($this->pdo === null) {
            $bucket = $this->buckets[$key] ?? null;
            if ($bucket === null || $now - $bucket['start'] >= $bucket['window']) {
                $bucket = ['start' => $now, 'hits' => 0, 'window' => $window];
            }
            $bucket['hits']++;
            $this->buckets[$key] = $bucket;
            return $bucket['hits'] <= $limit;
        }

        $stmt = $this->pdo->prepare('
            INSERT INTO rate_limits (bucket, window_start, hits, window_seconds) VALUES (:bucket, :now, 1, :window)
            ON CONFLICT(bucket) DO UPDATE SET
                hits = CASE WHEN :now - rate_limits.window_start >= rate_limits.window_seconds THEN 1 ELSE rate_limits.hits + 1 END,
                window_start = CASE WHEN :now - rate_limits.window_start >= rate_limits.window_seconds THEN :now ELSE rate_limits.window_start END,
                window_seconds = :window
            RETURNING hits
        ');
        $stmt->execute([':bucket' => $key, ':now' => $now, ':window' => $window]);
        $hits = (int)$stmt->fetchColumn();
        $stmt->closeCursor();

        if (random_int(1, 200) === 1) {
            $this->gc();
        }
        return $hits <= $limit;
    }

    /** Whether the bucket already holds $limit events in its current window, without counting this call. */
    public function exceeded(string $key, int $limit, int $window): bool
    {
        $now = ($this->clock)();
        if ($this->pdo === null) {
            $bucket = $this->buckets[$key] ?? null;
        } else {
            $stmt = $this->pdo->prepare('SELECT window_start AS start, hits, window_seconds AS window FROM rate_limits WHERE bucket = :bucket');
            $stmt->execute([':bucket' => $key]);
            $bucket = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        }
        return $bucket !== null && $now - (float)$bucket['start'] < (int)$bucket['window'] && (int)$bucket['hits'] >= $limit;
    }

    /** Drop buckets whose own window has ended. */
    public function gc(): void
    {
        $now = ($this->clock)();
        if ($this->pdo !== null) {
            $this->pdo->prepare('DELETE FROM rate_limits WHERE :now - window_start >= window_seconds')->execute([':now' => $now]);
            return;
        }
        foreach ($this->buckets as $key => $bucket) {
            if ($now - $bucket['start'] >= $bucket['window']) {
                unset($this->buckets[$key]);
            }
        }
    }

    /** Build a short, non-reversible bucket key so raw ids never touch disk. */
    public static function key(string $action, string $identity): string
    {
        return $action . ':' . substr(hash('sha256', $identity), 0, 16);
    }
}
