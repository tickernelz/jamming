@echo off
title Jamri Ngrok Tunnel Runner
echo ========================================================
echo   MENJALANKAN JAMRI NGROK TUNNEL (WEB + WEBSOCKET)
echo ========================================================
echo.

:: 1. Cek & Jalankan Daemon WebSocket di port 8080 jika belum aktif
netstat -ano | findstr :8080 >nul
if %errorlevel% neq 0 (
    echo [1/3] Menjalankan WebSocket Server (port 8080)...
    start /b php bin/websocket.php
) else (
    echo [1/3] WebSocket Server sudah berjalan di port 8080.
)

:: 2. Cek & Jalankan Unified Tunnel Gateway di port 3000 jika belum aktif
netstat -ano | findstr :3000 >nul
if %errorlevel% neq 0 (
    echo [2/3] Menjalankan Unified Gateway (port 3000)...
    start /b node bin/tunnel_gateway.js
) else (
    echo [2/3] Unified Gateway sudah berjalan di port 3000.
)

:: 3. Jalankan Ngrok menghubungkan ke port 3000
echo [3/3] Menghubungkan Ngrok ke port 3000...
echo.
echo Akses URL Ngrok yang muncul di layar HP Anda:
echo (Contoh: https://xxxx.ngrok-free.app/jamri/)
echo.
npx -y ngrok http 3000
