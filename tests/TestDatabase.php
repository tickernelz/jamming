<?php

declare(strict_types=1);

namespace Jamri\Tests;

use Jamri\Database;
use PDO;

final class TestDatabase
{
    public static function memory(): PDO
    {
        return Database::open('sqlite::memory:');
    }
}
