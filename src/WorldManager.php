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
    private ?RoomManager $roomManager;

    /** worldId => [ resId => avatar ] */
    private array $worlds = [];

    /** worldId => decoded map (in-memory cache; avoids a DB read per move). */
    private array $maps = [];

    /** worldId => ['at' => float, 'boxes' => array] short-lived box cache. */
    private array $boxesCache = [];

    /** worldId => [ resId => boxId|null ] authoritative active mat per user. */
    private array $activeBox = [];

    /** worldId => host device id (for owner crown indicator). */
    private array $hostDevice = [];

    public function __construct(PDO $pdo, ?RoomManager $roomManager = null)
    {
        $this->pdo = $pdo;
        $this->roomManager = $roomManager;
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
        unset($this->activeBox[$worldId][$resId]);
        if (!isset($this->worlds[$worldId][$resId])) {
            return false;
        }
        unset($this->worlds[$worldId][$resId]);
        if (empty($this->worlds[$worldId])) {
            unset($this->worlds[$worldId]);
            unset($this->activeBox[$worldId]);
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
        $owners = $this->ownerDevices($worldId);
        $out = [];
        foreach ($this->worlds[$worldId] ?? [] as $resId => $a) {
            $dev = (string)($a['device_id'] ?? '');
            $out[] = [
                'i' => $resId,
                'x' => round((float)$a['x'], 1),
                'y' => round((float)$a['y'], 1),
                'd' => (int)($a['dir'] ?? 0),
                'e' => (string)($a['emoji'] ?? '🎧'),
                'n' => (string)($a['nickname'] ?? 'Guest'),
                'o' => ($dev !== '' && isset($owners[$dev])) ? 1 : 0,
            ];
        }
        return $out;
    }

    public function setWorldHost(string $worldId, string $deviceId): void
    {
        $this->hostDevice[$worldId] = $deviceId;
    }

    /** Device ids considered "owners" (world host + mat owners) in a world. */
    private function ownerDevices(string $worldId): array
    {
        $set = [];
        $host = $this->hostDevice[$worldId] ?? '';
        if ($host !== '') {
            $set[$host] = true;
        }
        foreach ($this->getBoxes($worldId) as $b) {
            if (!empty($b['owner_device_id'])) {
                $set[$b['owner_device_id']] = true;
            }
        }
        return $set;
    }

    public function getAvatars(string $worldId): array
    {
        return array_values($this->worlds[$worldId] ?? []);
    }

    /** Raw resId => avatar map (needed to route per-connection zone changes). */
    public function avatarsByResId(string $worldId): array
    {
        return $this->worlds[$worldId] ?? [];
    }

    public function getAvatar(string $worldId, int $resId): ?array
    {
        return $this->worlds[$worldId][$resId] ?? null;
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

    // =====================================================================
    // Mats (jamming boxes): a circle where players share one audio room
    // =====================================================================

    public function boxRadius(): float
    {
        return 96.0;
    }

    /** Currently placed mats in a world (cached briefly to avoid a query per tick). */
    public function getBoxes(string $worldId): array
    {
        $cached = $this->boxesCache[$worldId] ?? null;
        if ($cached !== null && (microtime(true) - $cached['at']) < 1.0) {
            return $cached['boxes'];
        }

        $stmt = $this->pdo->prepare('
            SELECT b.*, r.name AS room_name, r.host_device_id,
                   (SELECT COUNT(*) FROM room_queue q WHERE q.room_id = b.room_id AND q.is_played = 0) AS queue_count
            FROM world_boxes b
            INNER JOIN rooms r ON r.id = b.room_id
            WHERE b.world_id = :world_id
            ORDER BY b.created_at ASC
        ');
        $stmt->execute([':world_id' => $worldId]);
        $boxes = $stmt->fetchAll();

        $this->boxesCache[$worldId] = ['at' => microtime(true), 'boxes' => $boxes];
        return $boxes;
    }

    public function invalidateBoxes(string $worldId): void
    {
        unset($this->boxesCache[$worldId]);
    }

    /** Compact, public-safe box payload for clients. */
    public function boxesPayload(string $worldId): array
    {
        $out = [];
        foreach ($this->getBoxes($worldId) as $b) {
            $out[] = [
                'id' => $b['id'],
                'room_id' => $b['room_id'],
                'label' => $b['label'],
                'x' => (float)$b['x'],
                'y' => (float)$b['y'],
                'r' => (float)$b['radius'],
                'owner' => $b['owner_device_id'],
                'control' => $b['control_mode'],
                'users' => $this->countInBox($worldId, (string)$b['id']),
                'name' => $b['room_name'] ?? $b['label'],
            ];
        }
        return $out;
    }

    public function getBox(string $worldId, string $boxId): ?array
    {
        foreach ($this->getBoxes($worldId) as $b) {
            if ($b['id'] === $boxId) {
                return $b;
            }
        }
        return null;
    }

    /** How many avatars currently sit inside a given mat's radius (by position). */
    public function countInBox(string $worldId, string $boxId): int
    {
        $box = null;
        foreach ($this->getBoxes($worldId) as $b) {
            if ($b['id'] === $boxId) {
                $box = $b;
                break;
            }
        }
        if ($box === null) {
            return 0;
        }
        $n = 0;
        foreach ($this->worlds[$worldId] ?? [] as $a) {
            if (hypot($a['x'] - $box['x'], $a['y'] - $box['y']) <= (float)$box['radius']) {
                $n++;
            }
        }
        return $n;
    }

    /** All mats whose radius currently contains the given point. */
    public function boxesContaining(string $worldId, float $x, float $y): array
    {
        $hits = [];
        foreach ($this->getBoxes($worldId) as $b) {
            if (hypot($x - $b['x'], $y - $b['y']) <= (float)$b['radius']) {
                $hits[] = $b;
            }
        }
        return $hits;
    }

    /** Place a mat: creates its backing audio room + a world_boxes row. */
    public function placeBox(string $worldId, string $deviceId, string $nickname, float $x, float $y, string $label, string $controlMode): ?array
    {
        $map = $this->getMap($worldId);
        $radius = $this->boxRadius();

        // Reject placement inside a wall or outside the world.
        if ($this->isBlocked($map, $x, $y)) {
            return null;
        }

        // Reject heavy overlap with an existing mat (keep mats readable).
        foreach ($this->getBoxes($worldId) as $b) {
            if (hypot($x - $b['x'], $y - $b['y']) < $radius * 1.25) {
                return null;
            }
        }

        if (count($this->getBoxes($worldId)) >= self::MAX_BOXES_PER_WORLD) {
            return null;
        }

        if ($this->roomManager === null) {
            return null;
        }

        $label = Validator::clean($label, 40) ?: ($nickname . "'s Tikar");
        $controlMode = in_array($controlMode, ['owner', 'everyone'], true) ? $controlMode : 'everyone';

        // A mat's audio room is a hidden 'box' room owned by the placer.
        $room = $this->roomManager->createRoom(
            $label,
            false,
            null,
            $deviceId,
            'box',
            $worldId,
            null,
            $controlMode
        );

        $id = $this->generateUuid();
        $stmt = $this->pdo->prepare('
            INSERT INTO world_boxes (id, world_id, room_id, owner_device_id, label, x, y, radius, control_mode)
            VALUES (:id, :world_id, :room_id, :owner, :label, :x, :y, :radius, :control)
        ');
        $stmt->execute([
            ':id' => $id,
            ':world_id' => $worldId,
            ':room_id' => $room['id'],
            ':owner' => $deviceId,
            ':label' => $label,
            ':x' => $x,
            ':y' => $y,
            ':radius' => $radius,
            ':control' => $controlMode,
        ]);

        $this->invalidateBoxes($worldId);

        return [
            'id' => $id,
            'world_id' => $worldId,
            'room_id' => $room['id'],
            'owner_device_id' => $deviceId,
            'label' => $label,
            'x' => $x,
            'y' => $y,
            'radius' => $radius,
            'control_mode' => $controlMode,
        ];
    }

    /** Remove a mat and its backing room (owner only — checked by caller). */
    public function removeBox(string $worldId, string $boxId): bool
    {
        $box = $this->getBox($worldId, $boxId);
        if ($box === null) {
            return false;
        }

        $this->pdo->prepare('DELETE FROM world_boxes WHERE id = :id AND world_id = :world_id')
            ->execute([':id' => $boxId, ':world_id' => $worldId]);
        $this->pdo->prepare('DELETE FROM rooms WHERE id = :room_id')
            ->execute([':room_id' => $box['room_id']]);

        $this->invalidateBoxes($worldId);
        return true;
    }

    /** Cache a user's authoritative zone decision. */
    public function setActiveBox(string $worldId, int $resId, ?string $boxId): void
    {
        if ($boxId === null) {
            unset($this->activeBox[$worldId][$resId]);
            return;
        }
        $this->activeBox[$worldId][$resId] = $boxId;
    }

    public function getActiveBox(string $worldId, int $resId): ?string
    {
        return $this->activeBox[$worldId][$resId] ?? null;
    }

    /** How many avatars are actively attached (not merely near) a given mat. */
    public function activeUsersInBox(string $worldId, string $boxId): int
    {
        $n = 0;
        foreach ($this->activeBox[$worldId] ?? [] as $assigned) {
            if ($assigned === $boxId) {
                $n++;
            }
        }
        return $n;
    }

    /** Mark a mat as empty (nobody attached) so it can be recycled later. */
    public function markBoxEmpty(string $boxId, bool $isEmpty): void
    {
        if ($isEmpty) {
            $stmt = $this->pdo->prepare('UPDATE world_boxes SET empty_since = CURRENT_TIMESTAMP WHERE id = :id AND empty_since IS NULL');
        } else {
            $stmt = $this->pdo->prepare('UPDATE world_boxes SET empty_since = NULL WHERE id = :id');
        }
        $stmt->execute([':id' => $boxId]);
    }

    /**
     * Remove mats that have had nobody on them for a while. Frees both the mat
     * and its backing audio room, and returns the removed mat ids so the world
     * can broadcast a mat.removed event.
     */
    public function purgeEmptyBoxes(string $worldId, int $idleSeconds = 120): array
    {
        $stmt = $this->pdo->prepare("
            SELECT id, room_id FROM world_boxes
            WHERE world_id = :world_id
              AND empty_since IS NOT NULL
              AND empty_since <= datetime('now', '-' || :seconds || ' seconds')
        ");
        $stmt->execute([':world_id' => $worldId, ':seconds' => $idleSeconds]);
        $rows = $stmt->fetchAll();

        if (empty($rows)) {
            return [];
        }

        $removed = [];
        foreach ($rows as $row) {
            $this->pdo->prepare('DELETE FROM world_boxes WHERE id = :id')->execute([':id' => $row['id']]);
            $this->pdo->prepare('DELETE FROM rooms WHERE id = :room_id')->execute([':room_id' => $row['room_id']]);
            $removed[] = $row['id'];
        }

        $this->invalidateBoxes($worldId);
        return $removed;
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
