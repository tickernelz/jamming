<?php

declare(strict_types=1);

namespace Jamri\Tests;

use Jamri\Http;
use Jamri\PasscodeGate;
use Jamri\RateLimiter;
use Jamri\RoomManager;
use Jamri\UserManager;
use PHPUnit\Framework\TestCase;

final class PasscodeGateTest extends TestCase
{
    private RoomManager $rooms;
    private PasscodeGate $gate;
    private string $roomId;
    private string $guest;

    protected function setUp(): void
    {
        $pdo = TestDatabase::memory();
        $this->rooms = new RoomManager($pdo);
        $users = new UserManager($pdo);
        $host = $users->register('Host', '🎧')['user']['device_id'];
        $this->guest = $users->register('Guest', '🎸')['user']['device_id'];
        $this->roomId = $this->rooms->createRoom('Vault', true, 'correct-horse', $host)['id'];
        $this->gate = new PasscodeGate($this->rooms, new RateLimiter(sys_get_temp_dir(), false));
    }

    private static function client(string $ip): string
    {
        return 'ip:' . Http::networkKey($ip);
    }

    public function testCorrectPasscodeGrantsAccess(): void
    {
        self::assertSame(PasscodeGate::INVALID, $this->gate->attempt($this->roomId, $this->guest, 'nope', self::client('203.0.113.1')));
        self::assertFalse($this->rooms->canAccess($this->roomId, $this->guest));

        self::assertSame(PasscodeGate::GRANTED, $this->gate->attempt($this->roomId, $this->guest, 'correct-horse', self::client('203.0.113.1')));
        self::assertTrue($this->rooms->canAccess($this->roomId, $this->guest));
    }

    public function testAddressesInOneSlash64ShareTheRoomBudget(): void
    {
        for ($i = 1; $i <= PasscodeGate::PER_ROOM_AND_NETWORK; $i++) {
            $outcome = $this->gate->attempt($this->roomId, $this->guest, 'guess' . $i, self::client('2001:db8:5:5::' . dechex($i)));
            self::assertSame(PasscodeGate::INVALID, $outcome);
        }

        self::assertSame(PasscodeGate::THROTTLED, $this->gate->attempt($this->roomId, $this->guest, 'correct-horse', self::client('2001:db8:5:5::beef')));
        self::assertSame(PasscodeGate::GRANTED, $this->gate->attempt($this->roomId, $this->guest, 'correct-horse', self::client('2001:db8:5:6::1')));
    }

    public function testFailuresAcrossNetworksLockTheRoom(): void
    {
        for ($i = 1; $i <= PasscodeGate::FAILURES_PER_ROOM; $i++) {
            $outcome = $this->gate->attempt($this->roomId, $this->guest, 'guess' . $i, self::client("198.51.100.{$i}"));
            self::assertSame(PasscodeGate::INVALID, $outcome);
        }

        self::assertSame(PasscodeGate::THROTTLED, $this->gate->attempt($this->roomId, $this->guest, 'correct-horse', self::client('192.0.2.200')));
        self::assertFalse($this->rooms->canAccess($this->roomId, $this->guest));
    }

    public function testSuccessesDoNotCountAsFailures(): void
    {
        for ($i = 1; $i <= PasscodeGate::FAILURES_PER_ROOM + 5; $i++) {
            $outcome = $this->gate->attempt($this->roomId, $this->guest, 'correct-horse', self::client("198.51.100.{$i}"));
            self::assertSame(PasscodeGate::GRANTED, $outcome);
        }
    }
}
