<?php
// api/soundboard.php
// Custom soundboard upload and management endpoint

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
require_once dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/config/database.php';

use Jamri\Database;
use Jamri\RoomManager;

$pdo = Database::getConnection();
$roomManager = new RoomManager($pdo);

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $roomId = trim((string)($_GET['room_id'] ?? ''));
    if ($roomId === '') {
        http_response_code(400);
        echo json_encode(['error' => 'room_id is required']);
        exit;
    }

    $soundboards = $roomManager->getSoundboards($roomId);
    echo json_encode([
        'success' => true,
        'soundboards' => $soundboards,
    ]);
    exit;
}

if ($method === 'POST') {
    $action = $_POST['action'] ?? 'upload';

    if ($action === 'delete') {
        $roomId = trim((string)($_POST['room_id'] ?? ''));
        $soundboardId = (int)($_POST['id'] ?? 0);

        if ($roomId === '' || $soundboardId <= 0) {
            http_response_code(400);
            echo json_encode(['error' => 'Invalid room_id or soundboard id']);
            exit;
        }

        $deleted = $roomManager->deleteSoundboard($roomId, $soundboardId);
        echo json_encode([
            'success' => $deleted,
            'id' => $soundboardId,
        ]);
        exit;
    }

    // Handle Upload
    $roomId = trim((string)($_POST['room_id'] ?? ''));
    $title = trim((string)($_POST['title'] ?? 'Soundboard'));
    $emoji = trim((string)($_POST['emoji'] ?? '🔊'));
    $duration = (float)($_POST['duration'] ?? 0.0);
    $nickname = trim((string)($_POST['nickname'] ?? 'Anonymous'));

    if ($roomId === '') {
        http_response_code(400);
        echo json_encode(['error' => 'room_id is required']);
        exit;
    }

    if ($duration > 15.5) {
        http_response_code(400);
        echo json_encode(['error' => 'Durasi audio maksimal adalah 15 detik!']);
        exit;
    }

    if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
        http_response_code(400);
        echo json_encode(['error' => 'File audio gagal diunggah atau tidak ditemukan']);
        exit;
    }

    $file = $_FILES['file'];
    $maxSize = 5 * 1024 * 1024; // 5MB
    if ($file['size'] > $maxSize) {
        http_response_code(400);
        echo json_encode(['error' => 'Ukuran file terlalu besar (maksimal 5MB)']);
        exit;
    }

    $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
    $allowedExts = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'webm'];
    if (!in_array($ext, $allowedExts, true)) {
        http_response_code(400);
        echo json_encode(['error' => 'Format file harus berupa audio (mp3, wav, ogg, m4a, webm)']);
        exit;
    }

    $uploadDir = dirname(__DIR__) . '/public/uploads/soundboard';
    if (!is_dir($uploadDir)) {
        mkdir($uploadDir, 0775, true);
    }

    $safeFileName = 'sb_' . bin2hex(random_bytes(8)) . '.' . $ext;
    $targetPath = $uploadDir . '/' . $safeFileName;

    if (!move_uploaded_file($file['tmp_name'], $targetPath)) {
        http_response_code(500);
        echo json_encode(['error' => 'Gagal menyimpan file audio ke server']);
        exit;
    }

    $fileUrl = 'public/uploads/soundboard/' . $safeFileName;
    $saved = $roomManager->addSoundboard(
        $roomId,
        $title,
        $emoji,
        $fileUrl,
        $duration,
        $nickname
    );

    echo json_encode([
        'success' => true,
        'soundboard' => $saved,
    ]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method not allowed']);
