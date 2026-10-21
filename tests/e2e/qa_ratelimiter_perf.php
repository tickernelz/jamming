<?php
// QA: measure RateLimiter cost. The daemon is long-lived and calls allow() on
// every message (world.move is 90/3s per device), so per-call file I/O matters.
require __DIR__ . '/../../vendor/autoload.php';

$rl = new Jamri\RateLimiter();

// 1) Same key, 2000 calls (hot path: one device moving)
$t0 = microtime(true);
for ($i = 0; $i < 2000; $i++) {
    $rl->allow(Jamri\RateLimiter::key('world_move', 'dev_hot'), 90, 3);
}
$t1 = microtime(true);
printf("same-key 2000 calls : %6.1f ms  (%.4f ms/call)\n", ($t1 - $t0) * 1000, ($t1 - $t0) * 1000 / 2000);

// 2) Distinct keys, 500 calls (many devices)
$rl2 = new Jamri\RateLimiter();
$t2 = microtime(true);
for ($i = 0; $i < 500; $i++) {
    $rl2->allow(Jamri\RateLimiter::key('world_move', 'dev_' . $i), 90, 3);
}
$t3 = microtime(true);
printf("distinct-key 500    : %6.1f ms  (%.4f ms/call)\n", ($t3 - $t2) * 1000, ($t3 - $t2) * 1000 / 500);

$file = __DIR__ . '/../../data/rate_limit.json';
printf("bucket file size    : %d bytes\n", is_file($file) ? filesize($file) : -1);

// 3) Simulate 60 seconds of a busy world: 10 devices * 30 moves/s = 1800 calls
$rl3 = new Jamri\RateLimiter();
$t4 = microtime(true);
for ($s = 0; $s < 60; $s++) {
    for ($d = 0; $d < 10; $d++) {
        for ($m = 0; $m < 3; $m++) {
            $rl3->allow(Jamri\RateLimiter::key('world_move', 'dev_' . $d), 90, 3);
        }
    }
}
$t5 = microtime(true);
printf("1800 calls (10 dev) : %6.1f ms total\n", ($t5 - $t4) * 1000);
printf("=> per-tick budget impact at 15 Hz over 60s (900 ticks): %.3f ms/tick\n", ($t5 - $t4) * 1000 / 900);
