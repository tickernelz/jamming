<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/config/database.php';

use Jamri\Http;
use Jamri\RateLimiter;
use Jamri\Validator;

Http::securityHeaders();
header('Cache-Control: public, max-age=86400');

$rateLimiter = RateLimiter::shared();
if (!$rateLimiter->allow(RateLimiter::key('lyrics', Http::clientKey()), 40, 60)) {
    Http::error('Terlalu banyak permintaan lirik. Coba lagi sebentar.', 429);
}

$title = Validator::clean($_GET['title'] ?? '', 160);
$artist = Validator::clean($_GET['artist'] ?? '', 120);
$duration = isset($_GET['duration']) ? Validator::duration($_GET['duration']) : 0;
$query = Validator::clean($_GET['q'] ?? '', 160);

$action = Validator::clean($_GET['action'] ?? '', 20);
$lyricId = isset($_GET['id']) ? max(0, (int)$_GET['id']) : 0;

// Direct get by LRCLIB ID
if ($action === 'get' || $lyricId > 0) {
    if ($lyricId <= 0) {
        echo json_encode(['success' => false, 'error' => 'Parameter id tidak valid.']);
        exit;
    }

    $cacheKey = 'lrclib_id_' . $lyricId;
    $cacheDir = __DIR__ . '/../data/lyrics_cache';
    if (!is_dir($cacheDir)) {
        @mkdir($cacheDir, 0755, true);
    }
    $cacheFile = $cacheDir . '/' . $cacheKey . '.json';
    if (file_exists($cacheFile) && (time() - filemtime($cacheFile) < 86400 * 30)) {
        $cached = @file_get_contents($cacheFile);
        if ($cached) {
            echo $cached;
            exit;
        }
    }

    $opts = [
        'http' => [
            'method' => 'GET',
            'header' => "User-Agent: JamriMusic/1.0 (https://github.com/jamri)\r\nAccept: application/json\r\n",
            'timeout' => 5.0,
            'ignore_errors' => true
        ]
    ];
    $context = stream_context_create($opts);
    $raw = @file_get_contents('https://lrclib.net/api/get/' . $lyricId, false, $context);
    $item = $raw ? json_decode($raw, true) : null;

    if (is_array($item) && (!empty($item['syncedLyrics']) || !empty($item['plainLyrics']))) {
        $out = [
            'success' => true,
            'found' => true,
            'id' => $item['id'] ?? $lyricId,
            'track_name' => $item['trackName'] ?? ($item['name'] ?? ''),
            'artist_name' => $item['artistName'] ?? '',
            'album_name' => $item['albumName'] ?? '',
            'duration' => $item['duration'] ?? 0,
            'synced' => !empty($item['syncedLyrics']),
            'synced_lyrics' => $item['syncedLyrics'] ?? null,
            'plain_lyrics' => $item['plainLyrics'] ?? '',
            'instrumental' => !empty($item['instrumental'])
        ];
        $jsonOut = json_encode($out, JSON_UNESCAPED_UNICODE);
        @file_put_contents($cacheFile, $jsonOut);
        echo $jsonOut;
        exit;
    }

    echo json_encode(['success' => false, 'found' => false, 'message' => 'Lirik tidak ditemukan di LRCLIB untuk ID tersebut.']);
    exit;
}

// Search endpoint returning list of choices
if ($action === 'search') {
    $searchQuery = $query !== '' ? $query : ($artist !== '' ? "{$artist} {$title}" : $title);
    if ($searchQuery === '') {
        echo json_encode(['success' => false, 'error' => 'Kata kunci pencarian kosong.']);
        exit;
    }

    $opts = [
        'http' => [
            'method' => 'GET',
            'header' => "User-Agent: JamriMusic/1.0 (https://github.com/jamri)\r\nAccept: application/json\r\n",
            'timeout' => 5.0,
            'ignore_errors' => true
        ]
    ];
    $context = stream_context_create($opts);
    $searchUrl = 'https://lrclib.net/api/search?' . http_build_query(['q' => $searchQuery]);
    $raw = @file_get_contents($searchUrl, false, $context);
    $items = $raw ? json_decode($raw, true) : [];

    $results = [];
    if (is_array($items)) {
        foreach (array_slice($items, 0, 20) as $item) {
            $results[] = [
                'id' => $item['id'] ?? 0,
                'track_name' => $item['trackName'] ?? ($item['name'] ?? ''),
                'artist_name' => $item['artistName'] ?? '',
                'album_name' => $item['albumName'] ?? '',
                'duration' => $item['duration'] ?? 0,
                'synced' => !empty($item['syncedLyrics']),
                'plain' => !empty($item['plainLyrics']),
                'instrumental' => !empty($item['instrumental'])
            ];
        }
    }

    echo json_encode([
        'success' => true,
        'action' => 'search',
        'query' => $searchQuery,
        'results' => $results
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($title === '' && $query === '') {
    echo json_encode([
        'success' => false,
        'error' => 'Parameter title atau q diperlukan.'
    ]);
    exit;
}

// Clean up YouTube video titles to extract clean song and artist names
function cleanYouTubeTitle(string $rawTitle, string $rawArtist = ''): array
{
    $clean = $rawTitle;

    // Remove text inside brackets / parentheses that indicate video metadata
    $patterns = [
        '/\s*[\(\[](official\s*(music\s*)?(video|audio|mv|lyric\s*video|visualizer|clip|hd|4k|remastered)?|mv|lyrics?|visualizer|remastered)[\)\]]/i',
        '/\s*[\(\[](feat\.|ft\.|featuring).*?[\)\]]/i',
        '/\s*[\(\[](lirik\s*(lagu)?|video\s*lirik)[\)\]]/i',
        '/\s*[\(\[].*?(cover|live|acoustic).*?[\)\]]/i',
        '/\s*[\(\[][^()\[\]]*(audio|soundtrack|ost)[^()\[\]]*[\)\]]/i',
        '/\s*\|\s*.*$/', // remove trailing pipe channels like "| Warner Records"
        '/^\s*#\w+\s*/', // remove leading hashtags
    ];
    foreach ($patterns as $p) {
        $clean = preg_replace($p, '', $clean);
    }
    $clean = trim($clean);

    $parsedArtist = $rawArtist;
    $parsedTrack = $clean;

    // Check if title has "Artist - Song" pattern
    if (strpos($clean, ' - ') !== false) {
        $parts = explode(' - ', $clean, 2);
        $parsedArtist = trim($parts[0]);
        $parsedTrack = trim($parts[1]);
    } elseif (strpos($clean, ' – ') !== false) { // en-dash
        $parts = explode(' – ', $clean, 2);
        $parsedArtist = trim($parts[0]);
        $parsedTrack = trim($parts[1]);
    } elseif (strpos($clean, ' : ') !== false) {
        $parts = explode(' : ', $clean, 2);
        $parsedArtist = trim($parts[0]);
        $parsedTrack = trim($parts[1]);
    }

    // Clean any residual trailing quotes
    $parsedTrack = trim($parsedTrack, " \"'");
    $parsedArtist = trim($parsedArtist, " \"'");

    // Clean artist suffix like " - Topic" from YouTube Music channels
    $parsedArtist = preg_replace('/\s*-\s*Topic$/i', '', $parsedArtist);
    $parsedArtist = preg_replace('/\s*VEVO$/i', '', $parsedArtist);

    return [
        'artist' => $parsedArtist,
        'track' => $parsedTrack
    ];
}

function fetchLrclib(string $url): ?array
{
    $opts = [
        'http' => [
            'method' => 'GET',
            'header' => "User-Agent: JamriMusic/1.0 (https://github.com/jamri)\r\nAccept: application/json\r\n",
            'timeout' => 4.5,
            'ignore_errors' => true
        ]
    ];
    $context = stream_context_create($opts);
    $raw = @file_get_contents($url, false, $context);
    if ($raw === false || $raw === '') {
        return null;
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : null;
}

// Check local disk cache
$cacheKey = md5($title . '|' . $artist . '|' . $duration . '|' . $query);
$cacheDir = __DIR__ . '/../data/lyrics_cache';
if (!is_dir($cacheDir)) {
    @mkdir($cacheDir, 0755, true);
}
$cacheFile = $cacheDir . '/' . $cacheKey . '.json';
if (file_exists($cacheFile) && (time() - filemtime($cacheFile) < 86400 * 7)) {
    $cached = @file_get_contents($cacheFile);
    if ($cached) {
        echo $cached;
        exit;
    }
}

$parsed = cleanYouTubeTitle($title, $artist);
$searchTrack = $parsed['track'];
$searchArtist = $parsed['artist'];

$lrclibResult = null;

// Attempt 1: Direct /api/get if we have track name and artist name
if ($searchTrack !== '' && $searchArtist !== '') {
    $params = [
        'track_name' => $searchTrack,
        'artist_name' => $searchArtist
    ];
    if ($duration > 0) {
        $params['duration'] = $duration;
    }
    $getUrl = 'https://lrclib.net/api/get?' . http_build_query($params);
    $res = fetchLrclib($getUrl);
    if ($res && (!empty($res['syncedLyrics']) || !empty($res['plainLyrics']))) {
        $lrclibResult = $res;
    }
}

// Attempt 2: Search with query
if (!$lrclibResult) {
    $qStr = $query !== '' ? $query : ($searchArtist !== '' ? "{$searchArtist} {$searchTrack}" : $searchTrack);
    $searchUrl = 'https://lrclib.net/api/search?' . http_build_query(['q' => $qStr]);
    $items = fetchLrclib($searchUrl);

    if (is_array($items) && !empty($items)) {
        // Prioritize items with syncedLyrics
        foreach ($items as $item) {
            if (!empty($item['syncedLyrics'])) {
                $lrclibResult = $item;
                break;
            }
        }
        if (!$lrclibResult && isset($items[0])) {
            $lrclibResult = $items[0];
        }
    }
}

// Attempt 3: Search with raw title only if nothing found yet
if (!$lrclibResult && $title !== '') {
    $searchUrl = 'https://lrclib.net/api/search?' . http_build_query(['q' => $title]);
    $items = fetchLrclib($searchUrl);
    if (is_array($items) && !empty($items)) {
        foreach ($items as $item) {
            if (!empty($item['syncedLyrics'])) {
                $lrclibResult = $item;
                break;
            }
        }
        if (!$lrclibResult && isset($items[0])) {
            $lrclibResult = $items[0];
        }
    }
}

if ($lrclibResult && (!empty($lrclibResult['syncedLyrics']) || !empty($lrclibResult['plainLyrics']))) {
    $hasSynced = !empty($lrclibResult['syncedLyrics']);
    $out = [
        'success' => true,
        'found' => true,
        'id' => $lrclibResult['id'] ?? 0,
        'track_name' => $lrclibResult['trackName'] ?? $searchTrack,
        'artist_name' => $lrclibResult['artistName'] ?? $searchArtist,
        'album_name' => $lrclibResult['albumName'] ?? '',
        'duration' => $lrclibResult['duration'] ?? $duration,
        'synced' => $hasSynced,
        'synced_lyrics' => $lrclibResult['syncedLyrics'] ?? null,
        'plain_lyrics' => $lrclibResult['plainLyrics'] ?? '',
        'instrumental' => !empty($lrclibResult['instrumental'])
    ];
} else {
    $out = [
        'success' => true,
        'found' => false,
        'track_name' => $searchTrack,
        'artist_name' => $searchArtist,
        'message' => 'Lirik tidak ditemukan di basis data open-source LRCLIB.'
    ];
}

$jsonOut = json_encode($out, JSON_UNESCAPED_UNICODE);
@file_put_contents($cacheFile, $jsonOut);
echo $jsonOut;
