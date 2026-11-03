<?php
// src/UserManager.php

declare(strict_types=1);

namespace Jamri;

use PDO;

class UserManager
{
    private PDO $pdo;

    public function __construct(PDO $pdo)
    {
        $this->pdo = $pdo;
    }

    public function getUser(string $deviceId): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM users WHERE device_id = :id');
        $stmt->execute([':id' => $deviceId]);
        $user = $stmt->fetch();
        return $user ?: null;
    }

    /**
     * Nickname does not need to be unique anymore (cuman buat seru-seruan)
     */
    public function isNicknameAvailable(string $nickname, ?string $excludeDeviceId = null): bool
    {
        return trim($nickname) !== '';
    }

    public function registerOrUpdate(string $deviceId, string $nickname, string $emoji): array
    {
        // Centralised sanitation: nicknames/emojis are broadcast to every client
        // in a room, so they must never carry markup or control characters.
        $nickname = Validator::nickname($nickname, 'Kawan Jamming');
        $emoji = Validator::emoji($emoji);

        $stmt = $this->pdo->prepare('
            INSERT INTO users (device_id, nickname, emoji, last_active)
            VALUES (:id, :nick, :emoji, datetime("now"))
            ON CONFLICT(device_id) DO UPDATE SET
                nickname = excluded.nickname,
                emoji = excluded.emoji,
                last_active = datetime("now")
        ');
        $stmt->execute([
            ':id' => $deviceId,
            ':nick' => $nickname,
            ':emoji' => $emoji,
        ]);

        return [
            'device_id' => $deviceId,
            'nickname' => $nickname,
            'emoji' => $emoji,
        ];
    }

    public function touch(string $deviceId): void
    {
        $stmt = $this->pdo->prepare('UPDATE users SET last_active = datetime("now") WHERE device_id = :id');
        $stmt->execute([':id' => $deviceId]);
    }
}
