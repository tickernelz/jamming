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
        $stmt = $this->pdo->prepare('SELECT device_id, nickname, emoji FROM users WHERE device_id = :id');
        $stmt->execute([':id' => $deviceId]);
        $user = $stmt->fetch();
        return $user ?: null;
    }

    public function userForToken(?string $token): ?array
    {
        if ($token === null || preg_match('/^[a-f0-9]{64}$/', $token) !== 1) {
            return null;
        }
        $stmt = $this->pdo->prepare('SELECT device_id, nickname, emoji FROM users WHERE session_hash = :hash');
        $stmt->execute([':hash' => hash('sha256', $token)]);
        return $stmt->fetch() ?: null;
    }

    /**
     * Create a user with a server-chosen device id; only the session token's hash is stored.
     * @return array{user: array{device_id: string, nickname: string, emoji: string}, token: string}
     */
    public function register(string $nickname, string $emoji): array
    {
        $token = bin2hex(random_bytes(32));
        $user = [
            'device_id' => 'dev_' . bin2hex(random_bytes(12)),
            'nickname' => Validator::nickname($nickname, 'Kawan Jamming'),
            'emoji' => Validator::emoji($emoji),
        ];
        $this->pdo->prepare('
            INSERT INTO users (device_id, nickname, emoji, session_hash, last_active)
            VALUES (:id, :nick, :emoji, :hash, datetime("now"))
        ')->execute([
            ':id' => $user['device_id'],
            ':nick' => $user['nickname'],
            ':emoji' => $user['emoji'],
            ':hash' => hash('sha256', $token),
        ]);
        return ['user' => $user, 'token' => $token];
    }

    public function updateProfile(string $deviceId, string $nickname, string $emoji): array
    {
        $user = [
            'device_id' => $deviceId,
            'nickname' => Validator::nickname($nickname, 'Kawan Jamming'),
            'emoji' => Validator::emoji($emoji),
        ];
        $this->pdo->prepare('
            UPDATE users SET nickname = :nick, emoji = :emoji, last_active = datetime("now") WHERE device_id = :id
        ')->execute([':id' => $deviceId, ':nick' => $user['nickname'], ':emoji' => $user['emoji']]);
        return $user;
    }
}
