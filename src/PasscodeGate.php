<?php

declare(strict_types=1);

namespace Jamri;

/** Checks a private-room passcode under rate limits and grants the device access on success. */
final class PasscodeGate
{
    public const GRANTED = 'granted';
    public const INVALID = 'invalid';
    public const THROTTLED = 'throttled';

    public const PER_NETWORK = 20;
    public const PER_ROOM_AND_NETWORK = 8;
    public const FAILURES_PER_ROOM = 30;
    public const WINDOW = 600;

    public function __construct(private RoomManager $rooms, private RateLimiter $limiter)
    {
    }

    public function attempt(string $roomId, string $deviceId, string $passcode, string $clientKey): string
    {
        $roomFailures = RateLimiter::key('passcode_fail', $roomId);
        if (
            $this->limiter->exceeded($roomFailures, self::FAILURES_PER_ROOM, self::WINDOW)
            || !$this->limiter->allow(RateLimiter::key('passcode_ip', $clientKey), self::PER_NETWORK, self::WINDOW)
            || !$this->limiter->allow(RateLimiter::key('passcode_room', $roomId . '|' . $clientKey), self::PER_ROOM_AND_NETWORK, self::WINDOW)
        ) {
            return self::THROTTLED;
        }
        if (!$this->rooms->verifyPasscode($roomId, $passcode)) {
            $this->limiter->allow($roomFailures, self::FAILURES_PER_ROOM, self::WINDOW);
            return self::INVALID;
        }
        $this->rooms->grantAccess($roomId, $deviceId);
        return self::GRANTED;
    }
}
