/* ==========================================================================
   BOTTOM PLAYER DOCK CONTROLLER
   ========================================================================== */
function bindPlayerDock(player) {
    const btnPlay = document.getElementById('btn-dock-play');
    const btnPrev = document.getElementById('btn-dock-prev');
    const btnNext = document.getElementById('btn-dock-next');
    const btnLoop = document.getElementById('btn-dock-loop');
    const btnShuffle = document.getElementById('btn-dock-shuffle');
    const btnDownloadJamri = document.getElementById('btn-dock-download-jamri');
    const volumeSlider = document.getElementById('dock-volume-slider');
    const btnMute = document.getElementById('btn-dock-mute');
    const btnMobileMute = document.getElementById('btn-dock-mobile-mute');
    const volumeVal = document.getElementById('dock-volume-val');
    const mobileVolumeSlider = document.getElementById('dock-mobile-volume-slider');
    const mobileVolumeVal = document.getElementById('dock-mobile-volume-val');
    const progressBar = document.getElementById('dock-progress-bar');
    const progressTooltip = document.getElementById('dock-progress-tooltip');
    const currentTimeLabel = document.getElementById('dock-current-time');
    const totalTimeLabel = document.getElementById('dock-total-time');

    function getVolumeSvg(vol, size = 15) {
        if (vol === 0) {
            return `
                <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                    <line x1="23" y1="9" x2="17" y2="15"></line>
                    <line x1="17" y1="9" x2="23" y2="15"></line>
                </svg>
            `;
        } else if (vol <= 0.5) {
            return `
                <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                </svg>
            `;
        } else {
            return `
                <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                </svg>
            `;
        }
    }

    function updateVolumeUi(vol) {
        if (volumeSlider) {
            volumeSlider.value = vol;
        }
        if (volumeVal) {
            volumeVal.textContent = Math.round(vol * 100) + '%';
        }
        if (mobileVolumeSlider) {
            mobileVolumeSlider.value = vol;
        }
        if (mobileVolumeVal) {
            mobileVolumeVal.textContent = Math.round(vol * 100) + '%';
        }
        if (btnMute) {
            btnMute.innerHTML = getVolumeSvg(vol, 15);
            btnMute.title = vol === 0 ? 'Bunyikan (Unmute Lokal)' : `Bisukan (Mute Lokal) - Volume ${Math.round(vol * 100)}%`;
        }
        if (btnMobileMute) {
            btnMobileMute.innerHTML = getVolumeSvg(vol, 15);
            btnMobileMute.title = vol === 0 ? 'Bunyikan (Unmute Lokal)' : `Bisukan (Mute Lokal) - Volume ${Math.round(vol * 100)}%`;
        }
    }

    // Initialize local volume display
    updateVolumeUi(player.volume);

    function isHostOnlyLocked() {
        const app = window.JAMRI_APP;
        return !!app && app.currentView === 'room'
            && app.roomControlMode !== 'everyone'
            && !(window.JAMRI_USER && window.JAMRI_USER.is_host);
    }

    function checkControlPermitted() {
        if (window.JAMRI_APP && window.JAMRI_APP.currentView === 'room' && window.JAMRI_APP.games && window.JAMRI_APP.games.isPunished()) {
            window.JAMRI_APP.games.notifyPunishedAction('mengontrol pemutaran musik');
            return false;
        }
        if (isHostOnlyLocked()) {
            showToast('Hanya host yang bisa mengatur musik. Minta host menyalakan Kontrol Bersama.', 'warning');
            return false;
        }
        return true;
    }

    // Play / Pause Click
    btnPlay.addEventListener('click', () => {
        if (!checkControlPermitted()) return;
        player.togglePlay();
    });

    let isNavThrottled = false;
    btnPrev.addEventListener('click', () => {
        if (!checkControlPermitted()) return;
        if (isNavThrottled) return;
        isNavThrottled = true;
        btnPrev.style.opacity = '0.5';
        btnPrev.style.pointerEvents = 'none';
        player.prev();
        setTimeout(() => {
            isNavThrottled = false;
            btnPrev.style.opacity = '1';
            btnPrev.style.pointerEvents = 'auto';
        }, 650);
    });

    btnNext.addEventListener('click', () => {
        if (!checkControlPermitted()) return;
        if (isNavThrottled) return;
        isNavThrottled = true;
        btnNext.style.opacity = '0.5';
        btnNext.style.pointerEvents = 'none';
        player.next();
        setTimeout(() => {
            isNavThrottled = false;
            btnNext.style.opacity = '1';
            btnNext.style.pointerEvents = 'auto';
        }, 650);
    });

    btnLoop.addEventListener('click', () => {
        if (!checkControlPermitted()) return;
        player.toggleLoop();
    });

    if (btnShuffle) {
        btnShuffle.addEventListener('click', () => {
            if (!checkControlPermitted()) return;
            player.toggleShuffle();
        });
    }

    // Local-only volume slider (desktop)
    if (volumeSlider) {
        volumeSlider.addEventListener('input', (e) => {
            player.setVolume(parseFloat(e.target.value));
        });
    }

    // Local-only volume slider (mobile)
    if (mobileVolumeSlider) {
        mobileVolumeSlider.addEventListener('input', (e) => {
            player.setVolume(parseFloat(e.target.value));
        });
    }

    // Local mute toggle buttons
    if (btnMute) {
        btnMute.addEventListener('click', () => {
            player.toggleMute();
        });
    }
    if (btnMobileMute) {
        btnMobileMute.addEventListener('click', () => {
            player.toggleMute();
        });
    }

    // Listen to local volume change events
    player.on('volume_change', (vol) => {
        updateVolumeUi(vol);
    });

    const scrub = { dragging: false, pointerId: null, preview: 0, current: 0, duration: 0 };

    function renderProgress(seconds, duration) {
        const pct = duration > 0 ? Math.max(0, Math.min(100, (seconds / duration) * 100)) : 0;
        progressBar.style.setProperty('--progress', pct + '%');
        currentTimeLabel.textContent = formatSeconds(seconds);
        totalTimeLabel.textContent = formatSeconds(duration);
        progressBar.setAttribute('aria-valuemax', String(Math.round(duration)));
        progressBar.setAttribute('aria-valuenow', String(Math.round(seconds)));
        progressBar.setAttribute('aria-valuetext', formatSeconds(seconds) + ' dari ' + formatSeconds(duration));
    }

    function syncScrubberState() {
        const disabled = !(scrub.duration > 0);
        const locked = !disabled && isHostOnlyLocked();
        progressBar.classList.toggle('is-disabled', disabled);
        progressBar.classList.toggle('is-locked', locked);
        progressBar.setAttribute('aria-disabled', String(disabled || locked));
        progressBar.title = locked ? 'Hanya host yang bisa menggeser lagu' : '';
    }

    function secondsAt(clientX) {
        const rect = progressBar.getBoundingClientRect();
        if (!(rect.width > 0) || !(scrub.duration > 0)) return 0;
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        progressTooltip.style.left = (ratio * 100) + '%';
        return ratio * scrub.duration;
    }

    function resetScrubber() {
        scrub.dragging = false;
        scrub.current = 0;
        scrub.duration = 0;
        progressBar.classList.remove('is-dragging');
        renderProgress(0, 0);
        syncScrubberState();
    }

    progressBar.addEventListener('pointermove', (e) => {
        if (scrub.duration > 0) {
            const sec = secondsAt(e.clientX);
            progressTooltip.textContent = formatSeconds(sec);
            if (scrub.dragging && e.pointerId === scrub.pointerId) {
                scrub.preview = sec;
                renderProgress(sec, scrub.duration);
            }
        }
    });

    progressBar.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !(scrub.duration > 0)) return;
        if (!checkControlPermitted()) return;
        e.preventDefault();
        scrub.dragging = true;
        scrub.pointerId = e.pointerId;
        progressBar.setPointerCapture(e.pointerId);
        progressBar.classList.add('is-dragging');
        scrub.preview = secondsAt(e.clientX);
        progressTooltip.textContent = formatSeconds(scrub.preview);
        renderProgress(scrub.preview, scrub.duration);
    });

    function endDrag(commit) {
        if (!scrub.dragging) return;
        scrub.dragging = false;
        progressBar.classList.remove('is-dragging');
        if (commit) {
            scrub.current = scrub.preview;
            player.seek(scrub.preview);
        } else {
            renderProgress(scrub.current, scrub.duration);
        }
    }

    progressBar.addEventListener('pointerup', (e) => {
        if (e.pointerId === scrub.pointerId) endDrag(true);
    });
    progressBar.addEventListener('pointercancel', (e) => {
        if (e.pointerId === scrub.pointerId) endDrag(false);
    });
    progressBar.addEventListener('lostpointercapture', () => endDrag(true));

    progressBar.addEventListener('keydown', (e) => {
        if (!(scrub.duration > 0)) return;
        const steps = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -30, PageUp: 30 };
        let target = null;
        if (e.key in steps) target = scrub.current + steps[e.key];
        else if (e.key === 'Home') target = 0;
        else if (e.key === 'End') target = scrub.duration - 1;
        if (target === null) return;
        e.preventDefault();
        if (!checkControlPermitted()) return;
        scrub.current = Math.max(0, Math.min(scrub.duration, target));
        renderProgress(scrub.current, scrub.duration);
        player.seek(scrub.current);
    });

    // Download as .jamri Click
    btnDownloadJamri.addEventListener('click', async () => {
        if (!player.currentTrack) {
            alert('Tidak ada lagu yang sedang diputar.');
            return;
        }

        btnDownloadJamri.disabled = true;
        const originalText = btnDownloadJamri.innerHTML;

        try {
            await player.downloadCurrentAsJamri((pct, msg) => {
                btnDownloadJamri.innerHTML = `<span>${Math.round(pct * 100)}%</span>`;
            });
            btnDownloadJamri.innerHTML = `<span>Tersimpan</span>`;
            setTimeout(() => {
                btnDownloadJamri.disabled = false;
                btnDownloadJamri.innerHTML = originalText;
            }, 1800);
        } catch (err) {
            alert(err.message || 'Gagal mengunduh file .jamri');
            btnDownloadJamri.disabled = false;
            btnDownloadJamri.innerHTML = originalText;
        }
    });

    // Synchronized Lyrics Click
    const btnDockLyrics = document.getElementById('btn-dock-lyrics');
    if (btnDockLyrics) {
        btnDockLyrics.addEventListener('click', () => {
            if (window.JAMRI_APP && window.JAMRI_APP.lyrics) {
                window.JAMRI_APP.lyrics.toggleModal();
            }
        });
    }

    // Player Events
    player.on('state_change', ({ isPlaying }) => {
        updateDockPlayButton(isPlaying);
    });

    player.on('track_change', (track) => {
        updateDockTrackDisplay(track);
        if (!track) resetScrubber();
    });

    player.on('playback_stopped', () => {
        if (!player.currentTrack) resetScrubber();
    });

    player.on('time_update', ({ currentTime, duration }) => {
        scrub.duration = duration > 0 ? duration : 0;
        syncScrubberState();
        if (scrub.dragging) return;
        scrub.current = currentTime;
        renderProgress(currentTime, scrub.duration);
    });

    player.on('shuffle_change', (isShuffled) => {
        if (!btnShuffle) return;
        btnShuffle.classList.toggle('active-control', isShuffled);
        btnShuffle.classList.toggle('btn-primary', isShuffled);
        btnShuffle.classList.toggle('btn-ghost', !isShuffled);
        btnShuffle.title = isShuffled ? 'Acak Antrean (Shuffle): AKTIF' : 'Acak Antrean (Shuffle): NON-AKTIF';
    });

    player.on('loop_change', (mode) => {
        btnLoop.classList.remove('active-control', 'loop-one', 'loop-all', 'btn-primary');
        btnLoop.classList.add('btn-ghost');

        const repeatArrow = `
                <polyline points="17 1 21 5 17 9"></polyline>
                <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                <polyline points="7 23 3 19 7 15"></polyline>
                <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>`;

        if (mode === 'one') {
            btnLoop.classList.add('active-control', 'loop-one', 'btn-primary');
            btnLoop.classList.remove('btn-ghost');
            btnLoop.style.color = '';
            btnLoop.title = 'Looping: ULANGI LAGU INI (1 lagu terus-menerus)';
            // Icon with a "1" badge distinguishes loop-one from loop-all.
            btnLoop.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    ${repeatArrow}
                </svg>
                <span class="loop-badge" style="position:absolute; top:-2px; right:-2px; font-size:8px; font-weight:800; line-height:1; background:var(--primary); color:#fff; border-radius:6px; padding:1px 3px;">1</span>
            `;
            btnLoop.style.position = 'relative';
        } else if (mode === 'all') {
            btnLoop.classList.add('active-control', 'loop-all', 'btn-primary');
            btnLoop.classList.remove('btn-ghost');
            btnLoop.style.color = '';
            btnLoop.title = 'Looping: PUTAR SEMUA ANTREAN (antrean berputar terus tanpa habis)';
            // Icon with an "ALL" badge distinguishes loop-all from loop-one.
            btnLoop.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    ${repeatArrow}
                </svg>
                <span class="loop-badge" style="position:absolute; top:-2px; right:-2px; font-size:7px; font-weight:800; line-height:1; background:var(--primary); color:#fff; border-radius:6px; padding:1px 3px;">ALL</span>
            `;
            btnLoop.style.position = 'relative';
        } else {
            btnLoop.title = 'Looping: NON-AKTIF (mainkan antrean sampai habis)';
            btnLoop.style.color = '';
            btnLoop.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    ${repeatArrow}
                </svg>
            `;
        }
    });
}

function updateDockPlayButton(isPlaying) {
    const btn = document.getElementById('btn-dock-play');
    if (!btn) return;
    if (isPlaying) {
        btn.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" rx="1"></rect>
                <rect x="14" y="4" width="4" height="16" rx="1"></rect>
            </svg>
        `;
        btn.title = 'Jeda';
    } else {
        btn.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="6 4 20 12 6 20 6 4"></polygon>
            </svg>
        `;
        btn.title = 'Putar';
    }
}

function updateDockTrackDisplay(track) {
    const titleEl = document.getElementById('dock-track-title');
    const artistEl = document.getElementById('dock-track-artist');
    const thumbEl = document.getElementById('dock-track-thumb');

    if (!track) {
        if (titleEl) titleEl.textContent = 'Tidak ada lagu yang diputar';
        if (artistEl) artistEl.textContent = 'Pilih musik untuk mulai';
        if (thumbEl) thumbEl.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="%231a202c"></svg>';
        return;
    }

    if (titleEl) titleEl.textContent = track.title;
    if (artistEl) artistEl.textContent = track.channel || 'Artis';
    if (thumbEl) thumbEl.src = safeImageUrl(track.thumbnail || track.thumbnail_url) || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="%231a202c"></svg>';
}
