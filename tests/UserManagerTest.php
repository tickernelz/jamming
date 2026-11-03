<?php

declare(strict_types=1);

namespace Jamri\Tests;

use Jamri\UserManager;
use Jamri\Validator;
use PHPUnit\Framework\TestCase;

final class UserManagerTest extends TestCase
{
    private UserManager $users;

    protected function setUp(): void
    {
        $this->users = new UserManager(TestDatabase::memory());
    }

    public function testRegisteredTokenResolvesToItsOwnUserOnly(): void
    {
        $alice = $this->users->register('Alice', '🎸');
        $bob = $this->users->register('Bob', '🦊');

        self::assertSame($alice['user'], $this->users->userForToken($alice['token']));
        self::assertSame('Bob', $this->users->userForToken($bob['token'])['nickname']);
        self::assertNotSame($alice['user']['device_id'], $bob['user']['device_id']);
    }

    public function testDeviceIdIsNotACredential(): void
    {
        $alice = $this->users->register('Alice', '🎸');

        self::assertNull($this->users->userForToken($alice['user']['device_id']));
        self::assertNull($this->users->userForToken(str_repeat('a', 64)));
        self::assertNull($this->users->userForToken(null));
    }

    public function testMarkupEmojiIsReplacedOnRegisterAndUpdate(): void
    {
        $payload = '<img src=x onerror="window.__xss=document.domain">';
        $session = $this->users->register('Mallory', $payload);
        self::assertSame(Validator::DEFAULT_EMOJI, $session['user']['emoji']);

        foreach (['<b>', '"', "'", 'a=b'] as $short) {
            $updated = $this->users->updateProfile($session['user']['device_id'], 'Mallory', $short);
            self::assertSame(Validator::DEFAULT_EMOJI, $updated['emoji'], $short);
        }
        self::assertSame(Validator::DEFAULT_EMOJI, $this->users->getUser($session['user']['device_id'])['emoji']);
    }

    public function testProfileUpdateKeepsDeviceAndSession(): void
    {
        $session = $this->users->register('Alice', '🎸');
        $this->users->updateProfile($session['user']['device_id'], 'Alicia', '🦉');

        self::assertSame(
            ['device_id' => $session['user']['device_id'], 'nickname' => 'Alicia', 'emoji' => '🦉'],
            $this->users->userForToken($session['token'])
        );
    }
}
