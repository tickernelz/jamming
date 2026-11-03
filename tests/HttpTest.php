<?php

declare(strict_types=1);

namespace Jamri\Tests;

use Jamri\Http;
use PHPUnit\Framework\TestCase;

final class HttpTest extends TestCase
{
    public function testIpv6IsGroupedBySlash64AndIpv4StaysExact(): void
    {
        self::assertSame('2001:db8:1:1::/64', Http::networkKey('2001:db8:1:1:aaaa:bbbb:cccc:dddd'));
        self::assertSame(Http::networkKey('2001:db8:1:1::1'), Http::networkKey('2001:0db8:0001:0001:ffff::9'));
        self::assertNotSame(Http::networkKey('2001:db8:1:1::1'), Http::networkKey('2001:db8:1:2::1'));
        self::assertSame('203.0.113.7', Http::networkKey('203.0.113.7'));
        self::assertSame('203.0.113.7', Http::networkKey('::ffff:203.0.113.7'));
        self::assertNotSame(Http::networkKey('203.0.113.7'), Http::networkKey('203.0.113.8'));
        self::assertSame('unknown', Http::networkKey('not-an-ip'));
    }
}
