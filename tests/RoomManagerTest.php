<?php

declare(strict_types=1);

namespace Jamri\Tests;

use Jamri\RoomManager;
use Jamri\UserManager;
use PDO;
use PHPUnit\Framework\TestCase;

final class RoomManagerTest extends TestCase
{
    private PDO $pdo;
    private RoomManager $rooms;
    private string $host;
    private string $guest;

    protected function setUp(): void
    {
        $this->pdo = TestDatabase::memory();
        $this->rooms = new RoomManager($this->pdo);
        $users = new UserManager($this->pdo);
        $this->host = $users->register('Host', '🎧')['user']['device_id'];
        $this->guest = $users->register('Guest', '🎸')['user']['device_id'];
    }

    private function privateRoom(): array
    {
        return $this->rooms->createRoom('Secret', true, 's3cretpass', $this->host, 'legacy', null, null, 'owner');
    }

    public function testPrivatePasscodeIsStoredHashedAndVerified(): void
    {
        $room = $this->privateRoom();
        $stored = $this->pdo->query("SELECT passcode FROM rooms WHERE id = '{$room['id']}'")->fetchColumn();

        self::assertNotSame('s3cretpass', $stored);
        self::assertTrue(password_verify('s3cretpass', $stored));
        self::assertTrue($this->rooms->verifyPasscode($room['id'], 's3cretpass'));
        self::assertFalse($this->rooms->verifyPasscode($room['id'], 'wrong'));
        self::assertFalse($this->rooms->verifyPasscode($room['id'], ''));
    }

    public function testPrivateRoomAccessRequiresHostOrGrant(): void
    {
        $room = $this->privateRoom();

        self::assertTrue($this->rooms->canAccess($room['id'], $this->host));
        self::assertFalse($this->rooms->canAccess($room['id'], $this->guest));
        self::assertFalse($this->rooms->canAccess($room['id'], ''));

        $this->rooms->grantAccess($room['id'], $this->guest);
        self::assertTrue($this->rooms->canAccess($room['id'], $this->guest));
        self::assertFalse($this->rooms->canAccess('missing-room', $this->host));
    }

    public function testPublicRoomIsOpenToEveryone(): void
    {
        $room = $this->rooms->createRoom('Lobby', false, null, $this->host);

        self::assertTrue($this->rooms->canAccess($room['id'], $this->guest));
        self::assertFalse($this->rooms->verifyPasscode($room['id'], 'anything'));
    }

    public function testSerializedRoomsNeverCarrySecretsOrHostIdentity(): void
    {
        $created = $this->privateRoom();
        $listed = array_map(fn (array $r): array => $this->rooms->publicView($r), $this->rooms->getPublicRooms());
        $detail = $this->rooms->getRoomDetail($created['id'], $this->guest);

        foreach ([$created, $listed[0], $detail['room']] as $view) {
            self::assertArrayNotHasKey('passcode', $view);
            self::assertArrayNotHasKey('host_device_id', $view);
            self::assertStringNotContainsString($this->host, json_encode($view));
        }
        self::assertTrue($created['is_host']);
        self::assertFalse($detail['room']['is_host']);
        self::assertSame('Host', $listed[0]['host_nickname']);
        self::assertSame('owner', $created['box_control']);
    }

    public function testControlModePersists(): void
    {
        $room = $this->privateRoom();

        $this->rooms->setControlMode($room['id'], 'everyone');
        self::assertSame('everyone', $this->rooms->getRoomSummary($room['id'])['box_control']);

        $this->rooms->setControlMode($room['id'], 'anything-else');
        self::assertSame('owner', $this->rooms->getRoomSummary($room['id'])['box_control']);
    }

    public function testDeletingRoomRemovesAccessGrants(): void
    {
        $room = $this->privateRoom();
        $this->rooms->grantAccess($room['id'], $this->guest);
        $this->pdo->exec("DELETE FROM rooms WHERE id = '{$room['id']}'");

        self::assertSame(0, (int)$this->pdo->query('SELECT COUNT(*) FROM room_access')->fetchColumn());
    }
}
