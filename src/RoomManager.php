<?php
// src/RoomManager.php

declare(strict_types=1);

namespace Jamri;

use PDO;

class RoomManager
{
    private PDO $pdo;

    public function __construct(PDO $pdo)
    {
        $this->pdo = $pdo;
    }

    public function createRoom(string $name, bool $isPrivate, ?string $passcode, string $hostDeviceId): array
    {
        $id = $this->generateUuid();
        $slugBase = preg_replace('/[^a-z0-9]+/i', '-', strtolower($name));
        $slug = trim($slugBase, '-') . '-' . substr(md5(uniqid('', true)), 0, 6);

        $stmt = $this->pdo->prepare('
            INSERT INTO rooms (id, name, slug, is_private, passcode, host_device_id, playback_state, empty_since)
            VALUES (:id, :name, :slug, :is_private, :passcode, :host_device_id, "stopped", CURRENT_TIMESTAMP)
        ');

        $stmt->execute([
            ':id' => $id,
            ':name' => $name,
            ':slug' => $slug,
            ':is_private' => $isPrivate ? 1 : 0,
            ':passcode' => $isPrivate && !empty($passcode) ? trim($passcode) : null,
            ':host_device_id' => $hostDeviceId,
        ]);

        return $this->getRoomSummary($id) ?? ['id' => $id, 'name' => $name, 'slug' => $slug];
    }

    public function getPublicRooms(string $search = ''): array
    {
        $this->purgeInactiveRooms(600);

        $sql = '
            SELECT r.id, r.name, r.slug, r.is_private, r.host_device_id, r.playback_state, r.playback_position, r.current_track_id, r.created_at,
                   u.nickname AS host_nickname, u.emoji AS host_emoji,
                   (SELECT COUNT(*) FROM room_queue q WHERE q.room_id = r.id AND q.is_played = 0) AS queue_count
            FROM rooms r
            LEFT JOIN users u ON u.device_id = r.host_device_id
        ';

        $params = [];
        if (trim($search) !== '') {
            $sql .= ' WHERE (r.name LIKE :search OR r.slug LIKE :search)';
            $params[':search'] = '%' . trim($search) . '%';
        }

        $sql .= ' ORDER BY r.created_at DESC LIMIT 50';
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll();
    }

    public function getRoomSummary(string $roomId): ?array
    {
        $stmt = $this->pdo->prepare('
            SELECT r.*, u.nickname AS host_nickname, u.emoji AS host_emoji
            FROM rooms r
            LEFT JOIN users u ON u.device_id = r.host_device_id
            WHERE r.id = :id
        ');
        $stmt->execute([':id' => $roomId]);
        $room = $stmt->fetch();
        return $room ?: null;
    }

    public function getRoomDetail(string $roomId, ?string $passcode = null): ?array
    {
        $room = $this->getRoomSummary($roomId);
        if (!$room) {
            return null;
        }

        if ($room['is_private'] && $room['passcode']) {
            if ($passcode !== $room['passcode']) {
                return ['error' => 'invalid_passcode', 'room' => ['id' => $room['id'], 'name' => $room['name'], 'is_private' => 1]];
            }
        }

        // Get unplayed queue
        $stmtQueue = $this->pdo->prepare('
            SELECT * FROM room_queue
            WHERE room_id = :room_id AND is_played = 0
            ORDER BY queue_order ASC
        ');
        $stmtQueue->execute([':room_id' => $roomId]);
        $queue = $stmtQueue->fetchAll();

        // Get playlist
        $stmtPlaylist = $this->pdo->prepare('
            SELECT * FROM room_playlist
            WHERE room_id = :room_id
            ORDER BY id DESC
        ');
        $stmtPlaylist->execute([':room_id' => $roomId]);
        $playlist = $stmtPlaylist->fetchAll();

        // Get last 10 chat messages
        $messages = $this->getChatMessages($roomId, null, 10);

        return [
            'room' => $room,
            'queue' => $queue,
            'playlist' => $playlist,
            'chat' => $messages,
        ];
    }

    public function addTrackToQueue(string $roomId, array $track, string $addedBy): ?array
    {
        $ytId = trim((string)($track['youtube_id'] ?? ''));
        if ($ytId === '') {
            return null;
        }

        // Check if track is already in the active/unplayed queue
        $checkStmt = $this->pdo->prepare('
            SELECT id FROM room_queue
            WHERE room_id = :room_id AND youtube_id = :youtube_id AND is_played = 0
            LIMIT 1
        ');
        $checkStmt->execute([
            ':room_id' => $roomId,
            ':youtube_id' => $ytId,
        ]);
        if ($checkStmt->fetchColumn()) {
            return null;
        }

        // Get max queue order
        $orderStmt = $this->pdo->prepare('SELECT COALESCE(MAX(queue_order), 0) + 1 AS next_order FROM room_queue WHERE room_id = :room_id');
        $orderStmt->execute([':room_id' => $roomId]);
        $nextOrder = (int)$orderStmt->fetchColumn();

        $stmt = $this->pdo->prepare('
            INSERT INTO room_queue (room_id, youtube_id, title, channel, duration_seconds, thumbnail_url, added_by_nickname, queue_order)
            VALUES (:room_id, :youtube_id, :title, :channel, :duration, :thumbnail, :added_by, :order)
        ');
        $stmt->execute([
            ':room_id' => $roomId,
            ':youtube_id' => $ytId,
            ':title' => $track['title'] ?? 'Untitled Track',
            ':channel' => $track['channel'] ?? 'YouTube',
            ':duration' => (int)($track['duration_seconds'] ?? $track['duration'] ?? 0),
            ':thumbnail' => $track['thumbnail_url'] ?? $track['thumbnail'] ?? '',
            ':added_by' => $addedBy,
            ':order' => $nextOrder,
        ]);

        $newId = (int)$this->pdo->lastInsertId();
        return array_merge($track, [
            'id' => $newId,
            'room_id' => $roomId,
            'added_by_nickname' => $addedBy,
            'queue_order' => $nextOrder,
            'is_played' => 0,
        ]);
    }

    public function addTrackToPlaylist(string $roomId, array $track, string $addedBy): ?array
    {
        $ytId = trim((string)($track['youtube_id'] ?? ''));
        if ($ytId === '') {
            return null;
        }

        // Check if track is already in room playlist (Bank Musik)
        $checkStmt = $this->pdo->prepare('
            SELECT id FROM room_playlist
            WHERE room_id = :room_id AND youtube_id = :youtube_id
            LIMIT 1
        ');
        $checkStmt->execute([
            ':room_id' => $roomId,
            ':youtube_id' => $ytId,
        ]);
        if ($checkStmt->fetchColumn()) {
            return null;
        }

        $stmt = $this->pdo->prepare('
            INSERT INTO room_playlist (room_id, youtube_id, title, channel, duration_seconds, thumbnail_url, added_by_nickname)
            VALUES (:room_id, :youtube_id, :title, :channel, :duration, :thumbnail, :added_by)
        ');
        $stmt->execute([
            ':room_id' => $roomId,
            ':youtube_id' => $ytId,
            ':title' => $track['title'] ?? 'Untitled Track',
            ':channel' => $track['channel'] ?? 'YouTube',
            ':duration' => (int)($track['duration_seconds'] ?? $track['duration'] ?? 0),
            ':thumbnail' => $track['thumbnail_url'] ?? $track['thumbnail'] ?? '',
            ':added_by' => $addedBy,
        ]);

        $newId = (int)$this->pdo->lastInsertId();
        return array_merge($track, [
            'id' => $newId,
            'room_id' => $roomId,
            'added_by_nickname' => $addedBy,
        ]);
    }

    public function getPlaylist(string $roomId): array
    {
        $stmt = $this->pdo->prepare('
            SELECT * FROM room_playlist
            WHERE room_id = :room_id
            ORDER BY id DESC
        ');
        $stmt->execute([':room_id' => $roomId]);
        return $stmt->fetchAll();
    }

    public function removeTrackFromPlaylist(string $roomId, int $playlistId): bool
    {
        $stmt = $this->pdo->prepare('DELETE FROM room_playlist WHERE room_id = :room_id AND id = :id');
        return $stmt->execute([':room_id' => $roomId, ':id' => $playlistId]);
    }

    public function removeTrackFromQueue(string $roomId, int $queueId): bool
    {
        $stmt = $this->pdo->prepare('DELETE FROM room_queue WHERE room_id = :room_id AND id = :id');
        return $stmt->execute([':room_id' => $roomId, ':id' => $queueId]);
    }

    public function reorderQueue(string $roomId, array $orderedIds): array
    {
        if (empty($orderedIds)) {
            return $this->getQueue($roomId);
        }

        $updateStmt = $this->pdo->prepare('UPDATE room_queue SET queue_order = :order WHERE id = :id AND room_id = :room_id');
        foreach ($orderedIds as $index => $id) {
            $updateStmt->execute([
                ':order' => $index + 1,
                ':id' => (int)$id,
                ':room_id' => $roomId,
            ]);
        }

        return $this->getQueue($roomId);
    }

    public function getQueueItem(string $roomId, int $queueId): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM room_queue WHERE room_id = :room_id AND id = :id LIMIT 1');
        $stmt->execute([':room_id' => $roomId, ':id' => $queueId]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function getPlaylistItem(string $roomId, int $playlistId): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM room_playlist WHERE room_id = :room_id AND id = :id LIMIT 1');
        $stmt->execute([':room_id' => $roomId, ':id' => $playlistId]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function shuffleQueue(string $roomId): array
    {
        $stmt = $this->pdo->prepare('SELECT id FROM room_queue WHERE room_id = :room_id AND is_played = 0 ORDER BY queue_order ASC');
        $stmt->execute([':room_id' => $roomId]);
        $ids = $stmt->fetchAll(PDO::FETCH_COLUMN);

        if (count($ids) <= 1) {
            return $this->getQueue($roomId);
        }

        shuffle($ids);
        $updateStmt = $this->pdo->prepare('UPDATE room_queue SET queue_order = :order WHERE id = :id');
        foreach ($ids as $index => $id) {
            $updateStmt->execute([':order' => $index + 1, ':id' => $id]);
        }

        return $this->getQueue($roomId);
    }

    public function getQueue(string $roomId): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM room_queue WHERE room_id = :room_id AND is_played = 0 ORDER BY queue_order ASC');
        $stmt->execute([':room_id' => $roomId]);
        return $stmt->fetchAll();
    }

    public function markTrackPlayed(string $roomId, int $queueId): void
    {
        $stmt = $this->pdo->prepare('UPDATE room_queue SET is_played = 1 WHERE room_id = :room_id AND id = :id');
        $stmt->execute([':room_id' => $roomId, ':id' => $queueId]);
    }

    public function prependTrackToQueue(string $roomId, array $track): array
    {
        $orderStmt = $this->pdo->prepare('SELECT COALESCE(MIN(queue_order), 1) - 1 FROM room_queue WHERE room_id = :room_id AND is_played = 0');
        $orderStmt->execute([':room_id' => $roomId]);
        $minOrder = (int)$orderStmt->fetchColumn();

        if (isset($track['id']) && (int)$track['id'] > 0) {
            $stmt = $this->pdo->prepare('UPDATE room_queue SET is_played = 0, queue_order = :order WHERE room_id = :room_id AND id = :id');
            $stmt->execute([':order' => $minOrder, ':room_id' => $roomId, ':id' => (int)$track['id']]);
            $track['queue_order'] = $minOrder;
            $track['is_played'] = 0;
            return $track;
        }

        $stmt = $this->pdo->prepare('
            INSERT INTO room_queue (room_id, youtube_id, title, channel, duration_seconds, thumbnail_url, added_by_nickname, queue_order, is_played)
            VALUES (:room_id, :youtube_id, :title, :channel, :duration, :thumbnail, :added_by, :order, 0)
        ');
        $stmt->execute([
            ':room_id' => $roomId,
            ':youtube_id' => $track['youtube_id'],
            ':title' => $track['title'],
            ':channel' => $track['channel'],
            ':duration' => (int)($track['duration_seconds'] ?? $track['duration'] ?? 0),
            ':thumbnail' => $track['thumbnail_url'] ?? $track['thumbnail'] ?? '',
            ':added_by' => $track['added_by_nickname'] ?? $track['added_by'] ?? 'Jamri',
            ':order' => $minOrder,
        ]);

        $newId = (int)$this->pdo->lastInsertId();
        return array_merge($track, [
            'id' => $newId,
            'room_id' => $roomId,
            'queue_order' => $minOrder,
            'is_played' => 0,
        ]);
    }

    public function moveTrackToEndOfQueue(string $roomId, int $queueId): void
    {
        $orderStmt = $this->pdo->prepare('SELECT COALESCE(MAX(queue_order), 0) + 1 FROM room_queue WHERE room_id = :room_id');
        $orderStmt->execute([':room_id' => $roomId]);
        $nextOrder = (int)$orderStmt->fetchColumn();

        $stmt = $this->pdo->prepare('UPDATE room_queue SET is_played = 0, queue_order = :order WHERE room_id = :room_id AND id = :id');
        $stmt->execute([':order' => $nextOrder, ':room_id' => $roomId, ':id' => $queueId]);
    }

    public function updatePlaybackState(string $roomId, string $state, float $position, ?string $trackId = null): void
    {
        $stmt = $this->pdo->prepare('
            UPDATE rooms
            SET playback_state = :state,
                playback_position = :pos,
                current_track_id = COALESCE(:track_id, current_track_id),
                last_state_change = CURRENT_TIMESTAMP
            WHERE id = :id
        ');
        $stmt->execute([
            ':state' => $state,
            ':pos' => $position,
            ':track_id' => $trackId,
            ':id' => $roomId,
        ]);
    }

    public function markEmptySince(string $roomId, bool $isEmpty): void
    {
        if ($isEmpty) {
            $stmt = $this->pdo->prepare('UPDATE rooms SET empty_since = CURRENT_TIMESTAMP WHERE id = :id AND empty_since IS NULL');
        } else {
            $stmt = $this->pdo->prepare('UPDATE rooms SET empty_since = NULL WHERE id = :id');
        }
        $stmt->execute([':id' => $roomId]);
    }

    public function purgeInactiveRooms(int $inactiveSeconds = 600): int
    {
        // 10 minutes inactive (0 users)
        // Uses SQLite native datetime relative comparison to guarantee exact UTC alignment with CURRENT_TIMESTAMP
        $stmt = $this->pdo->prepare("
            DELETE FROM rooms
            WHERE empty_since IS NOT NULL 
              AND empty_since <= datetime('now', '-' || :seconds || ' seconds')
        ");
        $stmt->execute([':seconds' => $inactiveSeconds]);
        return $stmt->rowCount();
    }

    public function saveChatMessage(string $roomId, string $nickname, string $emoji, string $message): array
    {
        $stmt = $this->pdo->prepare('
            INSERT INTO chat_messages (room_id, sender_nickname, sender_emoji, message)
            VALUES (:room_id, :nickname, :emoji, :message)
        ');
        $stmt->execute([
            ':room_id' => $roomId,
            ':nickname' => $nickname,
            ':emoji' => $emoji,
            ':message' => $message,
        ]);

        $newId = (int)$this->pdo->lastInsertId();
        return [
            'id' => $newId,
            'room_id' => $roomId,
            'sender_nickname' => $nickname,
            'sender_emoji' => $emoji,
            'message' => $message,
            'created_at' => date('Y-m-d H:i:s'),
        ];
    }

    public function getChatMessages(string $roomId, ?int $beforeId = null, int $limit = 10): array
    {
        if ($beforeId !== null) {
            $stmt = $this->pdo->prepare('
                SELECT * FROM chat_messages
                WHERE room_id = :room_id AND id < :before_id
                ORDER BY id DESC
                LIMIT :limit
            ');
            $stmt->bindValue(':before_id', $beforeId, PDO::PARAM_INT);
        } else {
            $stmt = $this->pdo->prepare('
                SELECT * FROM chat_messages
                WHERE room_id = :room_id
                ORDER BY id DESC
                LIMIT :limit
            ');
        }

        $stmt->bindValue(':room_id', $roomId, PDO::PARAM_STR);
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->execute();

        $rows = $stmt->fetchAll();
        // Return chronological order
        return array_reverse($rows);
    }

    public function getSoundboards(string $roomId): array
    {
        $stmt = $this->pdo->prepare('
            SELECT * FROM room_soundboard
            WHERE room_id = :room_id
            ORDER BY id ASC
        ');
        $stmt->execute([':room_id' => $roomId]);
        return $stmt->fetchAll();
    }

    public function addSoundboard(
        string $roomId,
        string $title,
        string $emoji,
        string $fileUrl,
        float $duration,
        string $nickname
    ): array {
        $stmt = $this->pdo->prepare('
            INSERT INTO room_soundboard (room_id, title, emoji, file_url, duration_seconds, added_by_nickname)
            VALUES (:room_id, :title, :emoji, :file_url, :duration_seconds, :added_by_nickname)
        ');
        $stmt->execute([
            ':room_id' => $roomId,
            ':title' => $title,
            ':emoji' => $emoji ?: '🔊',
            ':file_url' => $fileUrl,
            ':duration_seconds' => $duration,
            ':added_by_nickname' => $nickname,
        ]);

        $id = (int)$this->pdo->lastInsertId();
        return [
            'id' => $id,
            'room_id' => $roomId,
            'title' => $title,
            'emoji' => $emoji ?: '🔊',
            'file_url' => $fileUrl,
            'duration_seconds' => $duration,
            'added_by_nickname' => $nickname,
            'created_at' => date('Y-m-d H:i:s'),
        ];
    }

    public function deleteSoundboard(string $roomId, int $soundboardId): bool
    {
        // Retrieve file to delete
        $stmt = $this->pdo->prepare('SELECT file_url FROM room_soundboard WHERE id = :id AND room_id = :room_id');
        $stmt->execute([':id' => $soundboardId, ':room_id' => $roomId]);
        $row = $stmt->fetch();
        if ($row && !empty($row['file_url'])) {
            $baseDir = dirname(__DIR__);
            $localPath = $baseDir . '/' . ltrim($row['file_url'], '/');
            if (file_exists($localPath) && is_file($localPath)) {
                @unlink($localPath);
            }
        }

        $delStmt = $this->pdo->prepare('DELETE FROM room_soundboard WHERE id = :id AND room_id = :room_id');
        return $delStmt->execute([':id' => $soundboardId, ':room_id' => $roomId]);
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
