/* ==========================================================================
   UTILITY HELPERS
   ========================================================================== */
function formatSeconds(sec) {
    sec = Math.floor(sec || 0);
    if (sec <= 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, m => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[m]));
}

/**
 * Sanitise an avatar emoji before injecting it into innerHTML. The server already
 * validates this, but the client must never trust broadcast payloads either.
 */
function safeEmoji(str) {
    if (typeof str !== 'string' || str.length === 0 || str.length > 8) return '🎧';
    if (/[<>&"'`\/\\{}()\[\]=;:]/.test(str)) return '🎧';
    return str;
}

/**
 * Only allow image URLs from YouTube's own hosts. Blocks `javascript:`/`data:`
 * and HTML-breaking payloads carried through thumbnail fields.
 */
function safeImageUrl(url) {
    if (typeof url !== 'string' || url.length > 512) return '';
    if (/[<>"'\s]/.test(url)) return '';
    try {
        const u = new URL(url, window.location.origin);
        if (u.protocol !== 'https:') return '';
        const host = u.hostname.toLowerCase();
        const allowed = ['i.ytimg.com', 'img.youtube.com', 'yt3.ggpht.com', 'i9.ytimg.com'];
        return allowed.includes(host) ? u.href : '';
    } catch (e) {
        return '';
    }
}

function showToast(message, type = 'info') {
    let container = document.getElementById('jamri-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'jamri-toast-container';
        container.className = 'jamri-toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `jamri-toast jamri-toast-${type}`;

    let iconSvg = '';
    if (type === 'warning') {
        iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    } else if (type === 'success') {
        iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else {
        iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
    }

    toast.innerHTML = `
        <span class="toast-icon">${iconSvg}</span>
        <span class="toast-msg">${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);
    requestAnimationFrame(() => {
        toast.classList.add('toast-active');
    });

    setTimeout(() => {
        toast.classList.remove('toast-active');
        setTimeout(() => toast.remove(), 300);
    }, 2800);
}
window.showToast = showToast;

