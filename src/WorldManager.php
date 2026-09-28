<?php
// src/WorldManager.php

declare(strict_types=1);

namespace Jamri;

use PDO;

/**
 * Owns realtime world state: the generated map, avatar positions, and the
 * per-tick snapshot broadcast. Everything here is ephemeral (in-memory) except
 * for the world room row itself and its map_json — positions must never hit the
 * database.
 *
 * Phase 1 scope: presence only (join, move, snapshot). Mat/zone logic lives in
 * later phases but the map is already shaped to support it.
 */
class WorldManager
{
    public const MAX_USERS_PER_WORLD = 20;
    public const MAX_BOXES_PER_WORLD = 8;

    private PDO $pdo;

    /** worldId => [ resId => avatar ] */
    private array $worlds = [];

    /** worldId => decoded map (in-memory cache; avoids a DB read per move). */
    private array $maps = [];

    public function __construct(PDO $pdo)
    {
        $this->pdo = $pdo;
    }

    // ---------------------------------------------------------------------
    // Map generation (deterministic per world id)
    // ---------------------------------------------------------------------

    /**
     * Build (or restore) the tile map for a world. Stored in rooms.map_json so
     * walls are stable across reconnects and daemon restarts.
     */
    public function ensureMap(string $worldId): array
    {
        if (isset($this->maps[$worldId])) {
            return $this->maps[$worldId];
        }

        $stmt = $this->pdo->prepare('SELECT map_json FROM rooms WHERE id = :id');
        $stmt->execute([':id' => $worldId]);
        $existing = $stmt->fetchColumn();

        if (is_string($existing) && $existing !== '') {
            $decoded = json_decode($existing, true);
            if (is_array($decoded) && isset($decoded['w'], $decoded['h'])) {
                $this->maps[$worldId] = $decoded;
                return $decoded;
            }
        }

        $map = $this->generateMap($worldId);

        $update = $this->pdo->prepare('UPDATE rooms SET map_json = :map WHERE id = :id');
        $update->execute([
            ':map' => json_encode($map, JSON_UNESCAPED_UNICODE),
            ':id' => $worldId,
        ]);

        $this->maps[$worldId] = $map;
        return $map;
    }

    /** Cached map lookup (falls back to ensureMap). */
    public function getMap(string $worldId): array
    {
        return $this->maps[$worldId] ?? $this->ensureMap($worldId);
    }

    /**
     * Procedural but deterministic map: a hollow rectangular room with a few
     * interior wall blocks. Same world id always yields the same map.
     */
    private function generateMap(string $worldId): array
    {
        $w = 40;
        $h = 26;
        $colliders = [];

        // Border walls, 1 tile thick.
        $colliders[] = ['x' => 0, 'y' => 0, 'w' => $w, 'h' => 1];
        $colliders[] = ['x' => 0, 'y' => $h - 1, 'w' => $w, 'h' => 1];
        $colliders[] = ['x' => 0, 'y' => 0, 'w' => 1, 'h' => $h];
        $colliders[] = ['x' => $w - 1, 'y' => 0, 'w' => 1, 'h' => $h];

        // Deterministic seed from the world id so blocks are stable.
        $seed = crc32($worldId);
        mt_srand($seed);

        $blocks = 5;
        for ($i = 0; $i < $blocks; $i++) {
            $bw = mt_rand(3, 6);
            $bh = mt_rand(2, 4);
            $bx = mt_rand(3, max(3, $w - $bw - 3));
            $by = mt_rand(3, max(3, $h - $bh - 3));
            $colliders[] = ['x' => $bx, 'y' => $by, 'w' => $bw, 'h' => $bh];
        }
        // Restore a clean RNG state for other callers.
        mt_srand();

        return [
            'w' => $w,
            'h' => $h,
            'tile' => 32,
            'colliders' => $colliders,
            'spawn' => ['x' => intdiv($w, 2) * 32 + 16, 'y' => intdiv($h, 2) * 32 + 16],
        ];
    }

    /** Find a free spawn tile (avoid colliders), near the map centre. */
    public function spawnPoint(array $map): array
    {
        $tile = (int)($map['tile'] ?? 32);
        $cx = (int)($map['spawn']['x'] ?? ($map['w'] * $tile / 2));
        $cy = (int)($map['spawn']['y'] ?? ($map['h'] * $tile / 2));

        // Spiral outward until we find a spot not inside a collider.
        for ($r = 0; $r < 8; $r++) {
            for ($dx = -$r; $dx <= $r; $dx++) {
                foreach ([$cy - $r * $tile, $cy + $r * $tile] as $y) {
                    $x = $cx + $dx * $tile;
                    if (!$this->isBlocked($map, $x, $y)) {
                        return ['x' => (float)$x, 'y' => (float)$y];
                    }
                }
            }
            for ($dy = -$r; $dy <= $r; $dy++) {
                foreach ([$cx - $r * $tile, $cx + $r * $tile] as $x) {
                    $y = $cy + $dy * $tile;
                    if (!$this->isBlocked($map, $x, $y)) {
                        return ['x' => (float)$x, 'y' => (float)$y];
                    }
                }
            }
        }
        return ['x' => (float)$cx, 'y' => (float)$cy];
    }

    /** True when a world-space point falls inside a collider or out of bounds. */
    public function isBlocked(array $map, float $x, float $y): bool
    {
        $tile = (int)($map['tile'] ?? 32);
        $px = $x / $tile;
        $py = $y / $tile;

        if ($px < 1 || $py < 1 || $px > ($map['w'] - 1) || $py > ($map['h'] - 1)) {
            return true;
        }

        foreach ($map['colliders'] ?? [] as $c) {
            if ($px >= $c['x'] && $px < ($c['x'] + $c['w']) &&
                $py >= $c['y'] && $py < ($c['y'] + $c['h'])) {
                return true;
            }
        }
        return false;
    }

    // ---------------------------------------------------------------------
    // Presence
    // ---------------------------------------------------------------------

    public function join(string $worldId, int $resId, array $avatar): void
    {
        if (!isset($this->worlds[$worldId])) {
            $this->worlds[$worldId] = [];
        }
        $this->worlds[$worldId][$resId] = $avatar;
    }

    public function leave(string $worldId, int $resId): bool
    {
        if (!isset($this->worlds[$worldId][$resId])) {
            return false;
        }
        unset($this->worlds[$worldId][$resId]);
        if (empty($this->worlds[$worldId])) {
            unset($this->worlds[$worldId]);
            return true;
        }
        return false;
    }

    public function count(string $worldId): int
    {
        return count($this->worlds[$worldId] ?? []);
    }

    public function isFull(string $worldId): bool
    {
        return $this->count($worldId) >= self::MAX_USERS_PER_WORLD;
    }

    /** Apply a movement intent, validating against walls + bounds. */
    public function move(string $worldId, int $resId, array $map, float $x, float $y): bool
    {
        if (!isset($this->worlds[$worldId][$resId])) {
            return false;
        }
        if ($this->isBlocked($map, $x, $y)) {
            return false;
        }
        $this->worlds[$worldId][$resId]['x'] = $x;
        $this->worlds[$worldId][$resId]['y'] = $y;
        return true;
    }

    /** Compact snapshot of all avatars for broadcast. */
    public function snapshot(string $worldId): array
    {
        $out = [];
        foreach ($this->worlds[$worldId] ?? [] as $resId => $a) {
            $out[] = [
                'i' => $resId,
                'x' => round((float)$a['x'], 1),
                'y' => round((float)$a['y'], 1),
                'd' => (int)($a['dir'] ?? 0),
                'e' => (string)($a['emoji'] ?? '🎧'),
                'n' => (string)($a['nickname'] ?? 'Guest'),
            ];
        }
        return $out;
    }

    public function getAvatars(string $worldId): array
    {
        return array_values($this->worlds[$worldId] ?? []);
    }

    /** Remove avatars whose socket is gone (safety net for missed onClose). */
    public function prune(string $worldId, array $activeResIds): void
    {
        if (!isset($this->worlds[$worldId])) {
            return;
        }
        $keep = array_flip($activeResIds);
        foreach (array_keys($this->worlds[$worldId]) as $resId) {
            if (!isset($keep[$resId])) {
                unset($this->worlds[$worldId][$resId]);
            }
        }
        if (empty($this->worlds[$worldId])) {
            unset($this->worlds[$worldId]);
        }
    }

    public function allWorldIds(): array
    {
        return array_keys($this->worlds);
    }
}
