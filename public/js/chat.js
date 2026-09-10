/**
 * chat.js
 * Real-time room live chat with cursor-based pagination (Load More)
 * Guardrail: Emoji HANYA untuk avatar profil pengirim pesan.
 */

class JamriChat {
    constructor(containerEl, roomId, wsClient) {
        this.container = containerEl;
        this.roomId = roomId;
        this.ws = wsClient;
        this.earliestMessageId = null;
        this.hasMore = true;
        this.isLoading = false;

        this.onlineUsers = [];
        this.renderShell();
        this.setupEvents();
    }

    renderShell() {
        this.container.innerHTML = `
            <div class="chat-wrapper">
                <div class="chat-header">
                    <span class="chat-title">Live Chat</span>
                    <button type="button" id="chat-online-badge" class="badge badge-online-btn" title="Klik untuk melihat siapa saja yang online di room">
                        <span class="online-indicator-dot"></span>
                        <span id="chat-online-text">0 online</span>
                    </button>
                </div>
                <div class="chat-messages-container" id="chat-messages-box">
                    <div id="chat-load-more-container" class="load-more-box" style="display:none;">
                        <button type="button" id="btn-chat-load-more" class="btn btn-sm btn-outline">Muat Chat Sebelumnya</button>
                    </div>
                    <div id="chat-messages-list" class="messages-list"></div>
                </div>
                <form id="chat-input-form" class="chat-input-bar">
                    <input type="text" id="chat-text-input" class="chat-input" placeholder="Tulis pesan..." autocomplete="off" maxlength="300" />
                    <button type="submit" class="btn btn-primary btn-icon" title="Kirim">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="22" y1="2" x2="11" y2="13"></line>
                            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                        </svg>
                    </button>
                </form>
            </div>
        `;

        this.messagesList = this.container.querySelector('#chat-messages-list');
        this.loadMoreContainer = this.container.querySelector('#chat-load-more-container');
        this.btnLoadMore = this.container.querySelector('#btn-chat-load-more');
        this.inputForm = this.container.querySelector('#chat-input-form');
        this.inputField = this.container.querySelector('#chat-text-input');
        this.messagesBox = this.container.querySelector('#chat-messages-box');
        this.onlineBtn = this.container.querySelector('#chat-online-badge');
    }

    setupEvents() {
        this.inputForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = this.inputField.value.trim();
            if (text !== '') {
                this.ws.sendChatMessage(text);
                this.inputField.value = '';
            }
        });

        this.btnLoadMore.addEventListener('click', () => {
            this.loadOlderMessages();
        });

        if (this.onlineBtn) {
            this.onlineBtn.addEventListener('click', () => {
                this.showOnlineUsersModal();
            });
        }
    }

    initMessages(initialList) {
        this.messagesList.innerHTML = '';
        if (Array.isArray(initialList) && initialList.length > 0) {
            this.earliestMessageId = initialList[0].id;
            initialList.forEach(msg => this.appendMessage(msg, false));
            if (initialList.length >= 10) {
                this.loadMoreContainer.style.display = 'block';
            }
            this.scrollToBottom();
        } else {
            this.loadMoreContainer.style.display = 'none';
        }
    }

    appendMessage(msg, scroll = true) {
        const item = document.createElement('div');
        const isMe = window.JAMRI_USER && window.JAMRI_USER.nickname === msg.sender_nickname;
        item.className = `chat-bubble-row ${isMe ? 'chat-me' : 'chat-other'}`;

        const timeStr = new Date(msg.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        item.innerHTML = `
            <div class="chat-avatar-box">
                <span class="chat-user-emoji">${msg.sender_emoji || '🎧'}</span>
            </div>
            <div class="chat-bubble-content">
                <div class="chat-meta">
                    <span class="chat-sender-name">${this.escape(msg.sender_nickname)}</span>
                    <span class="chat-timestamp">${timeStr}</span>
                </div>
                <div class="chat-text">${this.escape(msg.message)}</div>
            </div>
        `;

        this.messagesList.appendChild(item);

        if (scroll) {
            this.scrollToBottom();
        }
    }

    prependMessages(olderList) {
        if (!olderList || olderList.length === 0) {
            this.hasMore = false;
            this.loadMoreContainer.style.display = 'none';
            return;
        }

        this.earliestMessageId = olderList[0].id;
        const prevHeight = this.messagesBox.scrollHeight;

        const fragment = document.createDocumentFragment();
        olderList.forEach(msg => {
            const item = document.createElement('div');
            const isMe = window.JAMRI_USER && window.JAMRI_USER.nickname === msg.sender_nickname;
            item.className = `chat-bubble-row ${isMe ? 'chat-me' : 'chat-other'}`;
            const timeStr = new Date(msg.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            item.innerHTML = `
                <div class="chat-avatar-box">
                    <span class="chat-user-emoji">${msg.sender_emoji || '🎧'}</span>
                </div>
                <div class="chat-bubble-content">
                    <div class="chat-meta">
                        <span class="chat-sender-name">${this.escape(msg.sender_nickname)}</span>
                        <span class="chat-timestamp">${timeStr}</span>
                    </div>
                    <div class="chat-text">${this.escape(msg.message)}</div>
                </div>
            `;
            fragment.appendChild(item);
        });

        this.messagesList.insertBefore(fragment, this.messagesList.firstChild);

        // Pertahankan posisi scroll saat prepend
        const newHeight = this.messagesBox.scrollHeight;
        this.messagesBox.scrollTop += (newHeight - prevHeight);

        if (olderList.length < 10) {
            this.hasMore = false;
            this.loadMoreContainer.style.display = 'none';
        }
    }

    async loadOlderMessages() {
        if (this.isLoading || !this.hasMore || !this.earliestMessageId) return;

        this.isLoading = true;
        this.btnLoadMore.disabled = true;
        this.btnLoadMore.textContent = 'Memuat...';

        try {
            const res = await fetch(`api/chat.php?room_id=${encodeURIComponent(this.roomId)}&before_id=${this.earliestMessageId}&limit=10`);
            const data = await res.json();
            if (data.success) {
                this.prependMessages(data.messages);
            }
        } catch (e) {
            console.error('Failed to load older messages:', e);
        } finally {
            this.isLoading = false;
            this.btnLoadMore.disabled = false;
            this.btnLoadMore.textContent = 'Muat Chat Sebelumnya';
        }
    }

    setOnlineUsers(users) {
        this.onlineUsers = Array.isArray(users) ? users : [];
        this.updateOnlineCount(this.onlineUsers.length);

        // If modal is currently open, refresh list
        const modal = document.getElementById('modal-room-online-users');
        if (modal && modal.style.display === 'flex') {
            this.renderOnlineUsersList(modal);
        }
    }

    updateOnlineCount(count) {
        const text = this.container.querySelector('#chat-online-text');
        if (text) {
            text.textContent = `${count} online`;
        }
    }

    showOnlineUsersModal() {
        let modal = document.getElementById('modal-room-online-users');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'modal-room-online-users';
            modal.className = 'jamri-modal-backdrop';
            modal.innerHTML = `
                <div class="jamri-modal-box online-users-modal-box">
                    <div class="jamri-modal-header">
                        <h3 id="online-users-modal-title">Peserta Online</h3>
                        <button type="button" class="btn btn-ghost btn-icon btn-sm btn-close-modal">✕</button>
                    </div>
                    <div class="jamri-modal-body" style="padding:10px 16px 16px;">
                        <div id="online-users-list-container" class="online-users-list"></div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            modal.querySelectorAll('.btn-close-modal').forEach(btn => {
                btn.addEventListener('click', () => { modal.style.display = 'none'; });
            });
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.style.display = 'none';
            });
        }

        this.renderOnlineUsersList(modal);
        modal.style.display = 'flex';
    }

    renderOnlineUsersList(modal) {
        const title = modal.querySelector('#online-users-modal-title');
        if (title) title.textContent = `Peserta Online (${this.onlineUsers.length})`;

        const container = modal.querySelector('#online-users-list-container');
        if (!container) return;

        if (this.onlineUsers.length === 0) {
            container.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-muted);">Tidak ada peserta lain.</div>';
            return;
        }

        const now = Math.floor(Date.now() / 1000);
        const myNickname = window.JAMRI_USER ? window.JAMRI_USER.nickname : '';
        container.innerHTML = this.onlineUsers.map(user => {
            const isMe = user.nickname === myNickname;
            const isPunished = (this.punishments || []).some(p => 
                (p.nickname === user.nickname || (user.device_id && p.device_id === user.device_id)) && p.until > now
            );
            return `
                <div class="online-user-row ${isMe ? 'is-me' : ''}">
                    <div class="online-user-avatar">${user.emoji || '🎧'}</div>
                    <div class="online-user-info">
                        <span class="online-user-name">${this.escape(user.nickname)}</span>
                        ${isMe ? '<span class="user-role-badge me">Anda</span>' : ''}
                        ${user.is_host ? '<span class="user-role-badge host">👑 Host</span>' : ''}
                        ${isPunished ? '<span class="user-role-badge punished">🚫 Dihukum</span>' : ''}
                    </div>
                    <span class="online-indicator-dot" title="Online"></span>
                </div>
            `;
        }).join('');
    }

    setPunishments(list) {
        this.punishments = list || [];
        const modal = document.getElementById('modal-room-online-users');
        if (modal && modal.style.display !== 'none') {
            this.renderOnlineUsersList(modal);
        }
    }

    appendActivityNotice(actionText, icon = 'ℹ️', triggeredBy = '') {
        const el = document.createElement('div');
        el.className = 'chat-activity-notice';
        el.innerHTML = `
            <span class="activity-icon">${icon}</span>
            <span class="activity-text">
                <strong class="activity-user">${this.escape(triggeredBy)}</strong> ${this.escape(actionText)}
            </span>
        `;
        this.messagesList.appendChild(el);
        this.scrollToBottom();
    }

    scrollToBottom() {
        this.messagesBox.scrollTop = this.messagesBox.scrollHeight;
    }

    escape(str) {
        return (str || '').replace(/[&<>"']/g, m => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        }[m]));
    }
}

window.JamriChat = JamriChat;
