<?php

declare(strict_types=1);

namespace Jamri\Tests;

use Jamri\RateLimiter;
use PHPUnit\Framework\TestCase;

final class RateLimiterTest extends TestCase
{
    private string $path;
    private float $now = 1_000_000.0;

    protected function setUp(): void
    {
        $this->path = tempnam(sys_get_temp_dir(), 'jamri-rl-');
    }

    protected function tearDown(): void
    {
        @unlink($this->path);
    }

    private function worker(): RateLimiter
    {
        return new RateLimiter(RateLimiter::openStore($this->path), fn (): float => $this->now);
    }

    public function testWorkersCreatedBeforeEitherWritesShareOneCount(): void
    {
        $a = $this->worker();
        $b = $this->worker();

        self::assertTrue($a->allow('passcode:x', 2, 600));
        self::assertTrue($b->allow('passcode:x', 2, 600));
        self::assertFalse($a->allow('passcode:x', 2, 600));
        self::assertTrue($b->exceeded('passcode:x', 2, 600));
    }

    public function testLongWindowSurvivesUnrelatedWritesAndGc(): void
    {
        $a = $this->worker();
        self::assertTrue($a->allow('passcode:x', 1, 600));

        $this->now += 301;
        $b = $this->worker();
        self::assertTrue($b->allow('chat_read:y', 60, 60));
        $b->gc();

        self::assertFalse($b->allow('passcode:x', 1, 600));
        self::assertTrue($b->exceeded('passcode:x', 1, 600));
    }

    public function testWindowResetsAfterItsOwnLength(): void
    {
        $a = $this->worker();
        self::assertTrue($a->allow('register:x', 1, 3600));
        self::assertFalse($a->allow('register:x', 1, 3600));

        $this->now += 3599;
        self::assertFalse($a->allow('register:x', 1, 3600));

        $this->now += 1;
        $a->gc();
        self::assertFalse($a->exceeded('register:x', 1, 3600));
        self::assertTrue($a->allow('register:x', 1, 3600));
    }

    public function testUnreadableStoreIsRecreated(): void
    {
        file_put_contents($this->path, str_repeat("\x5a", 4096));

        $limiter = $this->worker();

        self::assertTrue($limiter->allow('passcode:x', 1, 600));
        self::assertFalse($limiter->allow('passcode:x', 1, 600));
    }

    public function testInMemoryLimiterKeepsPerBucketWindow(): void
    {
        $limiter = new RateLimiter(null, fn (): float => $this->now);
        self::assertTrue($limiter->allow('ws:x', 1, 600));

        $this->now += 301;
        $limiter->gc();
        self::assertFalse($limiter->allow('ws:x', 1, 600));

        $this->now += 300;
        self::assertTrue($limiter->allow('ws:x', 1, 600));
    }
}
