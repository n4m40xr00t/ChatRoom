/* ==============================================
   ChatRoom — settings.js
   ============================================== */

/**
 * Reads the XSRF-TOKEN cookie value.
 * Spring Security's CookieCsrfTokenRepository writes this cookie;
 * we must send it back as the X-XSRF-TOKEN header on every mutating request.
 */
function getCsrfToken() {
    var match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
}

$(document).ready(function() {
    initSettingsTabs();
    loadDashboard();
    loadPersonalStats();
    loadPrivacySettings();
    loadBlockedUsers();

    /* ---- Profile / info form ---- */
    $('#profile-form').on('submit', function(e) {
        e.preventDefault();
        var formData = new FormData(this);
        var photoFile = document.getElementById('settings-photo-input').files[0];
        if (photoFile) {
            formData.set('profilePhoto', photoFile);
        }

        setLoading('#save-profile-btn', true);

        $.ajax({
            url: '/api/settings/update',
            method: 'POST',
            data: formData,
            processData: false,
            contentType: false,
            // SECURITY: include CSRF token header
            headers: { 'X-XSRF-TOKEN': getCsrfToken() },
            success: function(res) {
                showSettingsAlert('success', 'Profile updated successfully!');
            },
            error: function(xhr) {
                showSettingsAlert('error', xhr.responseText || 'Failed to update profile.');
            },
            complete: function() {
                setLoading('#save-profile-btn', false);
            }
        });
    });

    /* ---- Password form ---- */
    $('#password-form').on('submit', function(e) {
        e.preventDefault();
        var currentPw  = $('#current-password').val().trim();
        var newPw      = $('#new-password').val().trim();
        var confirmPw  = $('#confirm-password').val().trim();

        if (!currentPw || !newPw || !confirmPw) {
            showSettingsAlert('error', 'Please fill in all password fields.');
            return;
        }
        if (newPw !== confirmPw) {
            showSettingsAlert('error', 'New passwords do not match.');
            return;
        }
        // SECURITY: client-side policy matches server-side (min 8, upper, lower, digit, special)
        var strongPwPattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
        if (!strongPwPattern.test(newPw)) {
            showSettingsAlert('error', 'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a digit, and a special character (@$!%*?&).');
            return;
        }

        setLoading('#save-password-btn', true);

        $.ajax({
            url: '/api/settings/update-password',
            method: 'POST',
            contentType: 'application/json',
            // SECURITY: include CSRF token header
            headers: { 'X-XSRF-TOKEN': getCsrfToken() },
            data: JSON.stringify({
                currentPassword: currentPw,
                newPassword: newPw
            }),
            success: function() {
                showSettingsAlert('success', 'Password changed successfully!');
                $('#password-form')[0].reset();
            },
            error: function(xhr) {
                showSettingsAlert('error', xhr.responseText || 'Failed to change password.');
            },
            complete: function() {
                setLoading('#save-password-btn', false);
            }
        });
    });

    /* ---- Active Sessions ---- */
    loadActiveSessions();

    /* ---- Invitations & Groups ---- */
    initInvitations();
});

function loadActiveSessions() {
    var container = $('#active-sessions-list');
    container.html('<div style="text-align:center;padding:20px;"><i class="fi fi-rr-spinner" style="animation:spin 1s linear infinite;"></i> Loading sessions...</div>');
    
    $.ajax({
        url: '/api/sessions',
        method: 'GET',
        success: function(sessions) {
            container.empty();
            if (!sessions || sessions.length === 0) {
                container.html('<p style="color:var(--clr-text-muted);padding:10px;">No active sessions found.</p>');
                return;
            }
            
            sessions.forEach(function(s) {
                // SECURITY: build DOM safely instead of innerHTML to prevent XSS
                var item = document.createElement('div');
                item.className = 'settings-session-item';
                item.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:12px;border-bottom:1px solid rgba(255,255,255,0.05);';

                var infoDiv = document.createElement('div');

                var ipLine = document.createElement('div');
                ipLine.style.cssText = 'font-weight:600;font-size:13px;color:var(--clr-text-primary);';
                ipLine.textContent = s.ipAddress || 'Unknown IP';
                if (s.isCurrent) {
                    var badge = document.createElement('span');
                    badge.style.cssText = 'background:var(--clr-primary-dim);color:#93c5fd;padding:2px 6px;border-radius:4px;font-size:10px;margin-left:8px;';
                    badge.textContent = 'Current Session';
                    ipLine.appendChild(badge);
                }

                var uaLine = document.createElement('div');
                uaLine.style.cssText = 'font-size:11px;color:var(--clr-text-muted);margin-top:4px;';
                uaLine.textContent = s.userAgent || 'Unknown Device';

                var timeLine = document.createElement('div');
                timeLine.style.cssText = 'font-size:10px;color:var(--clr-text-muted);margin-top:4px;';
                timeLine.textContent = 'Last active: ' + new Date(s.lastActive).toLocaleString();

                infoDiv.appendChild(ipLine);
                infoDiv.appendChild(uaLine);
                infoDiv.appendChild(timeLine);
                item.appendChild(infoDiv);

                if (!s.isCurrent) {
                    var revokeBtn = document.createElement('button');
                    revokeBtn.className = 'settings-submit-btn';
                    revokeBtn.style.cssText = 'width:auto;padding:6px 12px;background:rgba(239, 68, 68, 0.2);color:#fca5a5;font-size:11px;';
                    revokeBtn.innerHTML = '<i class="fi fi-rr-cross-circle"></i> Revoke';
                    // SECURITY: use event listener, not inline onclick with id interpolation
                    (function(sessionId) {
                        revokeBtn.addEventListener('click', function() { revokeSession(sessionId); });
                    })(s.id);
                    item.appendChild(revokeBtn);
                }

                container.append(item);
            });
        },
        error: function() {
            container.html('<p style="color:#fca5a5;padding:10px;">Failed to load sessions.</p>');
        }
    });
}

function revokeSession(id) {
    openRevokeModal(id);
}

function doRevokeSession(id) {
    $.ajax({
        url: '/api/sessions/' + id,
        method: 'DELETE',
        headers: { 'X-XSRF-TOKEN': getCsrfToken() },
        success: function() {
            showSettingsAlert('success', 'Session revoked successfully.');
            loadActiveSessions();
        },
        error: function(xhr) {
            showSettingsAlert('error', xhr.responseText || 'Failed to revoke session.');
        }
    });
}

/* ---- Helpers ---- */
function showSettingsAlert(type, message) {
    var box = document.getElementById('settings-alert-box');
    if (!box) return;

    // SECURITY: build DOM nodes instead of using innerHTML to prevent XSS
    box.innerHTML = '';
    var alertDiv = document.createElement('div');
    alertDiv.className = 'settings-alert settings-alert-' + type;

    var icon = document.createElement('i');
    icon.className = 'fi ' + (type === 'success' ? 'fi-sr-check-circle' : 'fi-sr-exclamation');

    var span = document.createElement('span');
    // textContent prevents XSS — server error text is treated as plain text, not HTML
    span.textContent = message;

    alertDiv.appendChild(icon);
    alertDiv.appendChild(span);
    box.appendChild(alertDiv);
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // Auto-dismiss after 5s
    setTimeout(function() { box.innerHTML = ''; }, 5000);
}

function setLoading(selector, loading) {
    var btn = $(selector);
    if (loading) {
        btn.data('orig-html', btn.html());
        btn.html('<i class="fi fi-rr-spinner" style="animation:spin 1s linear infinite;"></i> Saving…');
        btn.prop('disabled', true);
    } else {
        var orig = btn.data('orig-html');
        if (orig) btn.html(orig);
        btn.prop('disabled', false);
    }
}


/* ============================================================
   MFA (Two-Factor Authentication) — Settings
   ============================================================ */

$(document).ready(function() {
    loadMfaStatus();
    initMfaSetupModal();
    initMfaDisableModal();
    initModalCountdown();
});

/* ---- Load and render MFA status ---- */
function loadMfaStatus() {
    $.ajax({
        url: '/api/mfa/status',
        method: 'GET',
        success: function(data) {
            renderMfaStatus(data.enabled);
        },
        error: function() {
            $('#mfa-status-label').text('Unable to load MFA status');
            $('#mfa-status-desc').text('Please refresh the page.');
        }
    });
}

function renderMfaStatus(enabled) {
    var icon    = document.getElementById('mfa-status-icon');
    var iconI   = document.getElementById('mfa-status-icon-i');
    var label   = document.getElementById('mfa-status-label');
    var desc    = document.getElementById('mfa-status-desc');
    var btn     = document.getElementById('mfa-toggle-btn');
    var btnIcon = document.getElementById('mfa-toggle-icon');
    var btnText = document.getElementById('mfa-toggle-text');

    if (enabled) {
        icon.className  = 'mfa-status-icon enabled';
        iconI.className = 'fi fi-sr-shield-check';
        label.textContent = 'Two-Factor Authentication is ON';
        desc.textContent  = 'Your account is protected with TOTP authentication.';
        btn.className  = 'mfa-toggle-btn disable';
        btnIcon.className = 'fi fi-sr-shield-slash';
        btnText.textContent = 'Disable';
    } else {
        icon.className  = 'mfa-status-icon disabled';
        iconI.className = 'fi fi-sr-shield';
        label.textContent = 'Two-Factor Authentication is OFF';
        desc.textContent  = 'Add an extra layer of security to your account.';
        btn.className  = 'mfa-toggle-btn enable';
        btnIcon.className = 'fi fi-sr-shield-plus';
        btnText.textContent = 'Enable';
    }
    btn.style.display = 'inline-flex';
    btn.dataset.mfaEnabled = enabled ? 'true' : 'false';
}

/* ---- Toggle button click ---- */
$(document).on('click', '#mfa-toggle-btn', function() {
    var enabled = $(this).data('mfa-enabled') === true || $(this).data('mfa-enabled') === 'true';
    if (enabled) {
        openMfaDisableModal();
    } else {
        openMfaSetupModal();
    }
});

/* ============================================================
   Setup Modal
   ============================================================ */
var mfaSetupSecret = '';

function openMfaSetupModal() {
    // Reset to step 1
    goToSetupStep(1);
    clearModalOtp();
    mfaSetupSecret = '';
    document.getElementById('mfa-qr-img').style.display = 'none';
    document.getElementById('mfa-qr-loading').style.display = 'flex';
    document.getElementById('mfa-secret-display').textContent = '—';
    hideMfaAlert('mfa-confirm-alert');

    document.getElementById('mfa-setup-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';

    // Fetch QR code from server
    $.ajax({
        url: '/api/mfa/setup',
        method: 'POST',
        headers: { 'X-XSRF-TOKEN': getCsrfToken() },
        success: function(data) {
            mfaSetupSecret = data.secret;
            var img = document.getElementById('mfa-qr-img');
            img.src = data.qrCode;
            img.style.display = 'block';
            document.getElementById('mfa-qr-loading').style.display = 'none';
            document.getElementById('mfa-secret-display').textContent = data.secret;
        },
        error: function(xhr) {
            document.getElementById('mfa-qr-loading').innerHTML =
                '<span style="color:#fca5a5;font-size:12px;text-align:center;padding:8px;">' +
                (xhr.responseJSON && xhr.responseJSON.error ? xhr.responseJSON.error : 'Failed to load QR code.') +
                '</span>';
        }
    });
}

function closeMfaSetupModal() {
    document.getElementById('mfa-setup-overlay').classList.remove('open');
    document.body.style.overflow = '';
}

function initMfaSetupModal() {
    document.getElementById('mfa-setup-close').addEventListener('click', closeMfaSetupModal);
    document.getElementById('mfa-setup-overlay').addEventListener('click', function(e) {
        if (e.target === this) closeMfaSetupModal();
    });

    // Copy secret key
    document.getElementById('mfa-copy-btn').addEventListener('click', function() {
        var secret = document.getElementById('mfa-secret-display').textContent;
        if (secret && secret !== '—') {
            navigator.clipboard.writeText(secret).then(function() {
                var btn = document.getElementById('mfa-copy-btn');
                btn.innerHTML = '<i class="fi fi-sr-check" style="color:#86efac;"></i>';
                setTimeout(function() {
                    btn.innerHTML = '<i class="fi fi-rr-copy"></i>';
                }, 1500);
            });
        }
    });

    // Next button (step 1 → 2)
    document.getElementById('mfa-next-btn').addEventListener('click', function() {
        if (!mfaSetupSecret) return;
        goToSetupStep(2);
        // Focus first digit
        setTimeout(function() { document.getElementById('md0').focus(); }, 100);
    });

    // Back button (step 2 → 1)
    document.getElementById('mfa-back-btn').addEventListener('click', function() {
        goToSetupStep(1);
        clearModalOtp();
        hideMfaAlert('mfa-confirm-alert');
    });

    // Confirm button (step 2 → verify)
    document.getElementById('mfa-confirm-btn').addEventListener('click', function() {
        var code = getModalOtpCode();
        if (code.length !== 6) {
            shakeModalOtp();
            return;
        }
        var btn = document.getElementById('mfa-confirm-btn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fi fi-rr-spinner" style="animation:spin 1s linear infinite;"></i> Verifying…';

        $.ajax({
            url: '/api/mfa/confirm',
            method: 'POST',
            contentType: 'application/json',
            headers: { 'X-XSRF-TOKEN': getCsrfToken() },
            data: JSON.stringify({ code: code }),
            success: function() {
                goToSetupStep(3);
                loadMfaStatus();
            },
            error: function(xhr) {
                var msg = (xhr.responseJSON && xhr.responseJSON.error)
                    ? xhr.responseJSON.error
                    : 'Invalid code. Please try again.';
                showMfaAlert('mfa-confirm-alert', 'error', msg);
                clearModalOtp();
                shakeModalOtp();
                btn.disabled = false;
                btn.innerHTML = '<i class="fi fi-sr-shield-check"></i> Confirm &amp; Enable';
                setTimeout(function() { document.getElementById('md0').focus(); }, 100);
            }
        });
    });

    // Done button (step 3 → close)
    document.getElementById('mfa-done-btn').addEventListener('click', function() {
        closeMfaSetupModal();
    });

    // Wire up modal OTP digit inputs
    initModalOtpInputs('mfa-modal-otp-digit', 'mfa-confirm-btn');
}

function goToSetupStep(step) {
    for (var i = 1; i <= 3; i++) {
        var panel = document.getElementById('mfa-panel-' + i);
        var dot   = document.getElementById('mfa-step-' + i);
        panel.classList.toggle('active', i === step);
        dot.classList.remove('active', 'done');
        if (i < step)  dot.classList.add('done');
        if (i === step) dot.classList.add('active');
    }
    // Lines
    var line1 = document.getElementById('mfa-line-1');
    var line2 = document.getElementById('mfa-line-2');
    if (line1) line1.classList.toggle('done', step > 1);
    if (line2) line2.classList.toggle('done', step > 2);
}

/* ============================================================
   Disable Modal
   ============================================================ */
function openMfaDisableModal() {
    document.getElementById('mfa-disable-password').value = '';
    hideMfaAlert('mfa-disable-alert');
    document.getElementById('mfa-disable-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(function() { document.getElementById('mfa-disable-password').focus(); }, 150);
}

function closeMfaDisableModal() {
    document.getElementById('mfa-disable-overlay').classList.remove('open');
    document.body.style.overflow = '';
}

function initMfaDisableModal() {
    document.getElementById('mfa-disable-close').addEventListener('click', closeMfaDisableModal);
    document.getElementById('mfa-disable-cancel-btn').addEventListener('click', closeMfaDisableModal);
    document.getElementById('mfa-disable-overlay').addEventListener('click', function(e) {
        if (e.target === this) closeMfaDisableModal();
    });

    document.getElementById('mfa-disable-confirm-btn').addEventListener('click', function() {
        var password = document.getElementById('mfa-disable-password').value;
        if (!password) {
            showMfaAlert('mfa-disable-alert', 'error', 'Please enter your password.');
            return;
        }

        var btn = document.getElementById('mfa-disable-confirm-btn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fi fi-rr-spinner" style="animation:spin 1s linear infinite;"></i> Disabling…';

        $.ajax({
            url: '/api/mfa/disable',
            method: 'POST',
            contentType: 'application/json',
            headers: { 'X-XSRF-TOKEN': getCsrfToken() },
            data: JSON.stringify({ password: password }),
            success: function() {
                closeMfaDisableModal();
                loadMfaStatus();
                showSettingsAlert('success', 'Two-factor authentication has been disabled.');
            },
            error: function(xhr) {
                var msg = (xhr.responseJSON && xhr.responseJSON.error)
                    ? xhr.responseJSON.error
                    : 'Failed to disable MFA.';
                showMfaAlert('mfa-disable-alert', 'error', msg);
                btn.disabled = false;
                btn.innerHTML = '<i class="fi fi-sr-shield-slash"></i> Disable MFA';
            }
        });
    });

    // Allow Enter key in password field
    document.getElementById('mfa-disable-password').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') document.getElementById('mfa-disable-confirm-btn').click();
    });
}

/* ============================================================
   Modal countdown ring (shared between setup step 2 and verify page)
   ============================================================ */
function initModalCountdown() {
    var ring  = document.getElementById('mfa-modal-ring');
    var label = document.getElementById('mfa-modal-timer-label');
    if (!ring || !label) return;

    var PERIOD = 30;
    var CIRCUMFERENCE = 2 * Math.PI * 18; // r=18

    ring.style.strokeDasharray  = CIRCUMFERENCE;
    ring.style.strokeDashoffset = 0;

    function tick() {
        var now       = Math.floor(Date.now() / 1000);
        var elapsed   = now % PERIOD;
        var remaining = PERIOD - elapsed;

        label.textContent = remaining;
        var fraction = remaining / PERIOD;
        ring.style.strokeDashoffset = CIRCUMFERENCE * (1 - fraction);

        if (remaining > 10) {
            ring.style.stroke = '#2563eb';
        } else if (remaining > 5) {
            ring.style.stroke = '#f59e0b';
        } else {
            ring.style.stroke = '#ef4444';
        }
    }

    tick();
    setInterval(tick, 1000);
}

/* ============================================================
   OTP digit input helpers
   ============================================================ */
function initModalOtpInputs(digitClass, submitBtnId) {
    var digits = document.querySelectorAll('.' + digitClass);

    digits.forEach(function(input, idx) {
        input.addEventListener('input', function() {
            this.value = this.value.replace(/\D/g, '').slice(-1);
            if (this.value && idx < digits.length - 1) {
                digits[idx + 1].focus();
            }
            // Auto-submit when all 6 filled
            if (getModalOtpCode().length === 6 && submitBtnId) {
                document.getElementById(submitBtnId).click();
            }
        });

        input.addEventListener('keydown', function(e) {
            if (e.key === 'Backspace' && !this.value && idx > 0) {
                digits[idx - 1].focus();
                digits[idx - 1].value = '';
            }
        });

        input.addEventListener('paste', function(e) {
            e.preventDefault();
            var pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
            if (pasted.length >= 6) {
                for (var i = 0; i < 6; i++) {
                    digits[i].value = pasted[i] || '';
                }
                digits[5].focus();
                if (submitBtnId) {
                    setTimeout(function() { document.getElementById(submitBtnId).click(); }, 50);
                }
            }
        });
    });
}

function getModalOtpCode() {
    var digits = document.querySelectorAll('.mfa-modal-otp-digit');
    var code = '';
    digits.forEach(function(d) { code += d.value; });
    return code;
}

function clearModalOtp() {
    document.querySelectorAll('.mfa-modal-otp-digit').forEach(function(d) { d.value = ''; });
}

function shakeModalOtp() {
    var row = document.getElementById('mfa-modal-otp-row');
    if (!row) return;
    row.classList.add('mfa-shake');
    setTimeout(function() { row.classList.remove('mfa-shake'); }, 500);
}

/* ============================================================
   Alert helpers
   ============================================================ */
function showMfaAlert(containerId, type, message) {
    var el = document.getElementById(containerId);
    if (!el) return;
    el.className = 'mfa-modal-alert ' + type;
    el.innerHTML = '';
    var icon = document.createElement('i');
    icon.className = 'fi ' + (type === 'success' ? 'fi-sr-check-circle' : 'fi-sr-exclamation');
    var span = document.createElement('span');
    span.textContent = message;
    el.appendChild(icon);
    el.appendChild(span);
}

function hideMfaAlert(containerId) {
    var el = document.getElementById(containerId);
    if (el) {
        el.className = 'mfa-modal-alert';
        el.innerHTML = '';
    }
}


/* ============================================================
   Appearance / Theme Picker — Settings
   ============================================================ */

$(document).ready(function () {
    initThemePicker();
});

function initThemePicker() {
    // Read current values from <html> attributes (set server-side)
    var currentTheme  = document.documentElement.getAttribute('data-theme')  || 'dark';
    var currentChatBg = document.documentElement.getAttribute('data-chatbg') || 'bubbles';

    // Mark active swatches
    setActiveThemeSwatch(currentTheme);
    setActiveChatBgSwatch(currentChatBg);
    updatePreviewAvatars(currentTheme);

    // Theme swatch clicks — instant preview + localStorage
    document.querySelectorAll('.theme-swatch').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var t = this.getAttribute('data-theme');
            document.documentElement.setAttribute('data-theme', t);
            setActiveThemeSwatch(t);
            updatePreviewAvatars(t);
            // Save to localStorage immediately for instant persistence
            try { localStorage.setItem('cr_theme', t); } catch(e){}
        });
    });

    // Chat background swatch clicks — instant preview + localStorage
    document.querySelectorAll('.chatbg-swatch').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var bg = this.getAttribute('data-chatbg');
            document.documentElement.setAttribute('data-chatbg', bg);
            setActiveChatBgSwatch(bg);
            // Save to localStorage immediately for instant persistence
            try { localStorage.setItem('cr_chatbg', bg); } catch(e){}
        });
    });

    // Save button — persist to server
    document.getElementById('save-theme-btn').addEventListener('click', function () {
        var theme  = document.documentElement.getAttribute('data-theme')  || 'dark';
        var chatBg = document.documentElement.getAttribute('data-chatbg') || 'bubbles';

        setLoading('#save-theme-btn', true);

        $.ajax({
            url: '/api/settings/theme',
            method: 'POST',
            contentType: 'application/json',
            headers: { 'X-XSRF-TOKEN': getCsrfToken() },
            data: JSON.stringify({ theme: theme, chatBg: chatBg }),
            success: function () {
                showSettingsAlert('success', 'Appearance saved!');
            },
            error: function (xhr) {
                showSettingsAlert('error', xhr.responseText || 'Failed to save appearance.');
            },
            complete: function () {
                setLoading('#save-theme-btn', false);
            }
        });
    });
}

function setActiveThemeSwatch(theme) {
    document.querySelectorAll('.theme-swatch').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-theme') === theme);
    });
}

function setActiveChatBgSwatch(chatBg) {
    document.querySelectorAll('.chatbg-swatch').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-chatbg') === chatBg);
    });
}

/* ---- Mini chat preview avatar colors ---- */
function updatePreviewAvatars(theme) {
    var colorMap = {
        dark:     '#2563eb',
        midnight: '#7c3aed',
        ocean:    '#0891b2',
        forest:   '#16a34a',
        rose:     '#e11d48',
        slate:    '#475569'
    };
    var color = colorMap[theme] || '#2563eb';
    document.querySelectorAll('.theme-preview-avatar').forEach(function (el) {
        el.style.background = color;
    });
}

/* ============================================================
   Revoke Session Modal
   ============================================================ */
var _revokeTargetId = null;

function openRevokeModal(sessionId) {
    _revokeTargetId = sessionId;
    var overlay = document.getElementById('revoke-session-overlay');
    if (!overlay) return;
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeRevokeModal() {
    var overlay = document.getElementById('revoke-session-overlay');
    if (overlay) overlay.classList.remove('open');
    document.body.style.overflow = '';
    _revokeTargetId = null;
}

$(document).ready(function() {
    // Close on backdrop click
    $('#revoke-session-overlay').on('click', function(e) {
        if (e.target === this) closeRevokeModal();
    });

    // Cancel button
    $('#revoke-cancel-btn').on('click', function() {
        closeRevokeModal();
    });

    // Confirm button
    $('#revoke-confirm-btn').on('click', function() {
        if (_revokeTargetId === null) return;
        var id = _revokeTargetId;
        closeRevokeModal();
        doRevokeSession(id);
    });

    // Escape key
    $(document).on('keydown.revokeModal', function(e) {
        if (e.key === 'Escape') closeRevokeModal();
    });
});

/* ============================================================
   Invitations & Groups Logic
   ============================================================ */
function initInvitations() {
    // Generate Personal Invite Link
    $('#generateInviteBtn').on('click', function() {
        var btn = $(this);
        var origHtml = btn.html();
        btn.html('<i class="fi fi-rr-spinner" style="animation:spin 1s linear infinite;"></i>');
        btn.prop('disabled', true);

        $.ajax({
            url: '/api/invite/generate',
            method: 'POST',
            headers: { 'X-XSRF-TOKEN': getCsrfToken() },
            success: function(res) {
                var link = window.location.origin + '/invite/' + res.token;
                $('#inviteLinkContainer').show();
                var input = $('#inviteLinkInput');
                input.val(link);
                input.select();
                document.execCommand('copy');

                btn.html('<i class="fi fi-sr-check"></i> Copied!');
                setTimeout(function() {
                    btn.html(origHtml);
                    btn.prop('disabled', false);
                }, 2000);
            },
            error: function() {
                showSettingsAlert('error', 'Failed to generate link');
                btn.html(origHtml);
                btn.prop('disabled', false);
            }
        });
    });

    // Accept Invite Token
    $('#acceptInviteBtn').on('click', function() {
        var tokenInput = $('#inviteTokenInput').val().trim();
        if (!tokenInput) {
            showSettingsAlert('error', 'Please enter a token or link.');
            return;
        }
        var token = tokenInput;
        // If they pasted a full URL, extract the token
        var match = token.match(/\/invite\/([a-zA-Z0-9\-]+)/);
        if (match && match[1]) {
            token = match[1];
        }

        var btn = $(this);
        var origHtml = btn.html();
        btn.html('<i class="fi fi-rr-spinner" style="animation:spin 1s linear infinite;"></i>');
        btn.prop('disabled', true);

        // We can just redirect them to the accept route, which will do the work
        // and redirect back to settings with a flash message.
        window.location.href = '/invite/' + token;
    });

    // Load Admin Groups
    loadAdminGroups();
}

function loadAdminGroups() {
    var container = $('#admin-groups-list');
    
    $.ajax({
        url: '/api/groups',
        method: 'GET',
        success: function(groups) {
            container.empty();
            var adminGroups = groups.filter(g => g.myRole === 'ADMIN');
            
            if (adminGroups.length === 0) {
                container.html('<p style="color:var(--clr-text-muted);font-size:12px;">You are not an admin of any groups.</p>');
                return;
            }

            adminGroups.forEach(function(g) {
                var groupItem = document.createElement('div');
                groupItem.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.03); padding:10px 16px; border-radius:8px; border:1px solid var(--clr-border);';

                var nameDiv = document.createElement('div');
                nameDiv.style.cssText = 'font-weight:600; color:var(--clr-text-primary); font-size:14px;';
                nameDiv.textContent = g.name;

                var linkBtn = document.createElement('button');
                linkBtn.className = 'settings-submit-btn';
                linkBtn.style.cssText = 'margin:0; width:auto; padding:6px 12px; font-size:12px;';
                linkBtn.innerHTML = '<i class="fi fi-br-link"></i> Link';
                
                linkBtn.addEventListener('click', function() {
                    generateGroupLink(g.id, linkBtn);
                });

                groupItem.appendChild(nameDiv);
                groupItem.appendChild(linkBtn);
                container.append(groupItem);
            });
        },
        error: function() {
            container.html('<p style="color:#fca5a5;font-size:12px;">Failed to load groups.</p>');
        }
    });
}

/* ============================================================
   Personal Message Statistics
   ============================================================ */
function loadPersonalStats() {
    var container = document.getElementById('stats-grid');
    if (!container) return;

    $.ajax({
        url: '/api/settings/stats',
        method: 'GET',
        success: function(stats) {
            renderStats(container, stats);
        },
        error: function() {
            container.innerHTML = '<div class="stats-loading" style="color:#fca5a5;">Failed to load statistics.</div>';
        }
    });
}

function renderStats(container, stats) {
    container.innerHTML = '';

    var totalSent = createStatItem(stats.totalSent, 'Messages Sent', '');
    container.appendChild(totalSent);

    var totalReceived = createStatItem(stats.totalReceived, 'Messages Received', '');
    container.appendChild(totalReceived);

    // Type breakdown for sent messages
    var typeData = stats.typeBreakdown || {};
    var textCount = typeData['TEXT'] || 0;
    var voiceCount = typeData['VOICE'] || 0;
    var imageCount = 0;
    var fileCount = 0;
    Object.keys(typeData).forEach(function(k) {
        if (k === 'IMAGE' || k === 'IMAGE_FILE') imageCount += (typeData[k] || 0);
        if (k !== 'TEXT' && k !== 'VOICE' && k !== 'IMAGE' && k !== 'IMAGE_FILE') fileCount += (typeData[k] || 0);
    });

    var typeBreakdown = document.createElement('div');
    typeBreakdown.className = 'stat-breakdown';
    typeBreakdown.innerHTML =
        '<div class="stat-breakdown-item"><span class="stat-breakdown-dot" style="background:#2563eb;"></span> Text: <span class="stat-breakdown-value">' + textCount + '</span></div>' +
        '<div class="stat-breakdown-item"><span class="stat-breakdown-dot" style="background:#16a34a;"></span> Voice: <span class="stat-breakdown-value">' + voiceCount + '</span></div>' +
        '<div class="stat-breakdown-item"><span class="stat-breakdown-dot" style="background:#f59e0b;"></span> Images: <span class="stat-breakdown-value">' + imageCount + '</span></div>' +
        '<div class="stat-breakdown-item"><span class="stat-breakdown-dot" style="background:#ef4444;"></span> Files: <span class="stat-breakdown-value">' + fileCount + '</span></div>';
    container.appendChild(typeBreakdown);

    // Activity bar chart (last 7 days)
    var activity = stats.dailyActivity || [];
    if (activity.length > 0) {
        var maxVal = 1;
        activity.forEach(function(p) { if (p.count > maxVal) maxVal = p.count; });

        var barChart = document.createElement('div');
        barChart.className = 'stat-bar-chart';

        activity.forEach(function(p) {
            var bar = document.createElement('div');
            bar.className = 'stat-bar';
            var pct = (p.count / maxVal) * 100;
            bar.style.height = Math.max(pct, 3) + '%';
            bar.innerHTML =
                '<span class="stat-bar-count">' + p.count + '</span>' +
                '<span class="stat-bar-label">' + formatDayLabel(p.date) + '</span>';
            barChart.appendChild(bar);
        });

        container.appendChild(barChart);
    }

    // Top chat partner
    if (stats.topPartner) {
        var partnerItem = createStatItem(stats.topPartnerCount, 'Most Messages With', '@' + stats.topPartner);
        partnerItem.className = partnerItem.className + ' full-width';
        container.appendChild(partnerItem);
    }

    // Account age
    if (stats.createdAt) {
        var created = new Date(stats.createdAt);
        var now = new Date();
        var daysOld = Math.floor((now - created) / (1000 * 60 * 60 * 24));
        var ageStr = daysOld + ' day' + (daysOld !== 1 ? 's' : '');
        var ageItem = createStatItem(ageStr, 'Account Age', '');
        ageItem.className = ageItem.className + ' full-width';
        container.appendChild(ageItem);
    }
}

function createStatItem(value, label, sub) {
    var item = document.createElement('div');
    item.className = 'stat-item';

    var valDiv = document.createElement('div');
    valDiv.className = 'stat-value';
    valDiv.textContent = typeof value === 'number' ? value.toLocaleString() : value;

    var labelDiv = document.createElement('div');
    labelDiv.className = 'stat-label';
    labelDiv.textContent = label;

    item.appendChild(valDiv);
    item.appendChild(labelDiv);

    if (sub) {
        var subDiv = document.createElement('div');
        subDiv.style.cssText = 'font-size:11px;color:var(--clr-text-muted);margin-top:2px;';
        subDiv.textContent = sub;
        item.appendChild(subDiv);
    }

    return item;
}

function formatDayLabel(dateStr) {
    if (!dateStr) return '';
    var parts = dateStr.split('-');
    if (parts.length >= 3) {
        return parseInt(parts[1]) + '/' + parseInt(parts[2]);
    }
    return dateStr;
}

/* ============================================================
   Settings Tab Navigation
   ============================================================ */
function initSettingsTabs() {
    var tabs = document.querySelectorAll('.settings-tab');
    tabs.forEach(function(tab) {
        tab.addEventListener('click', function() {
            var target = this.getAttribute('data-tab');
            switchTab(target);
        });
    });

    // Open tab from URL hash on load
    var hash = window.location.hash.replace('#', '');
    if (hash && ['dashboard','profile','appearance','security','account'].indexOf(hash) >= 0) {
        switchTab(hash);
    }
}

function switchTab(tabName) {
    // Update all tab buttons (both desktop sidebar and mobile)
    document.querySelectorAll('.settings-tab').forEach(function(t) {
        t.classList.toggle('active', t.getAttribute('data-tab') === tabName);
    });

    // Show/hide dashboard section
    var dashSection = document.getElementById('dashboard-section');
    if (dashSection) {
        dashSection.style.display = tabName === 'dashboard' ? '' : 'none';
    }

    // Show/hide grid cards by data-section
    var cards = document.querySelectorAll('#settings-grid > .settings-card');
    var visibleIndex = 0;
    cards.forEach(function(card) {
        var section = card.getAttribute('data-section');
        // Cards without data-section are always visible (e.g. alerts)
        if (!section) {
            card.style.display = '';
            return;
        }
        if (section === tabName || tabName === 'dashboard') {
            card.style.display = '';
            card.classList.remove('hidden-section', 'section-entering');
            card.style.setProperty('--i', visibleIndex);
    
            // Stagger animation (skip on dashboard to avoid flash)
            if (tabName !== 'dashboard') {
                // Force reflow so the animation re-triggers
                void card.offsetWidth;
                card.classList.add('section-entering');
            }
            visibleIndex++;
        } else {
            card.style.display = 'none';
            card.classList.add('hidden-section');
            card.classList.remove('section-entering');
        }
    });

    // Update URL hash
    if (window.history.replaceState) {
        window.history.replaceState(null, '', '#' + tabName);
    }

    // Scroll to top of content
    var content = document.getElementById('settings-content');
    if (content) {
        content.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

/* ============================================================
   Dashboard Row
   ============================================================ */
function loadDashboard() {
    var row = document.getElementById('dashboard-row');
    if (!row) return;

    $.ajax({
        url: '/api/settings/stats',
        method: 'GET',
        success: function(stats) {
            renderDashboard(row, stats);
        },
        error: function() {
            row.innerHTML = '<div class="dashboard-loading" style="color:#fca5a5;font-size:12px;">Failed to load dashboard.</div>';
        }
    });
}

function renderDashboard(row, stats) {
    row.innerHTML = '';

    var accountAge = '—';
    if (stats.createdAt) {
        var created = new Date(stats.createdAt);
        var now = new Date();
        var daysOld = Math.floor((now - created) / (1000 * 60 * 60 * 24));
        accountAge = daysOld + 'd';
    }

    var dashItems = [
        { value: (stats.totalSent || 0).toLocaleString(), label: 'Messages Sent' },
        { value: (stats.groupsCount || 0).toLocaleString(), label: 'Groups Joined' },
        { value: (stats.sessionsCount || 0).toLocaleString(), label: 'Active Sessions' },
        { value: accountAge, label: 'Account Age' }
    ];

    dashItems.forEach(function(item, idx) {
        var card = document.createElement('div');
        card.className = 'dashboard-card';
        card.style.setProperty('--i', idx);

        var valDiv = document.createElement('div');
        valDiv.className = 'dashboard-card-value';
        valDiv.textContent = item.value;

        var labelDiv = document.createElement('div');
        labelDiv.className = 'dashboard-card-label';
        labelDiv.textContent = item.label;

        card.appendChild(valDiv);
        card.appendChild(labelDiv);
        row.appendChild(card);
    });
}

/* ============================================================
   Privacy Settings
   ============================================================ */
function loadPrivacySettings() {
    $.ajax({
        url: '/api/settings/privacy',
        method: 'GET',
        success: function(settings) {
            var contactRadio = document.querySelector('input[name="contactPrivacy"][value="' + settings.contactPrivacy + '"]');
            if (contactRadio) contactRadio.checked = true;

            document.getElementById('privacy-online-status').checked = settings.showOnlineStatus;
            document.getElementById('privacy-read-receipts').checked = settings.sendReadReceipts;
        },
        error: function() {}
    });
}

$(document).on('click', '#save-privacy-btn', function() {
    var contactPrivacy = document.querySelector('input[name="contactPrivacy"]:checked');
    if (!contactPrivacy) return;

    var data = {
        contactPrivacy: contactPrivacy.value,
        showOnlineStatus: document.getElementById('privacy-online-status').checked,
        sendReadReceipts: document.getElementById('privacy-read-receipts').checked
    };

    setLoading('#save-privacy-btn', true);
    $.ajax({
        url: '/api/settings/privacy',
        method: 'POST',
        contentType: 'application/json',
        headers: { 'X-XSRF-TOKEN': getCsrfToken() },
        data: JSON.stringify(data),
        success: function() {
            showSettingsAlert('success', 'Privacy settings saved.');
        },
        error: function(xhr) {
            showSettingsAlert('error', xhr.responseText || 'Failed to save privacy settings.');
        },
        complete: function() {
            setLoading('#save-privacy-btn', false);
        }
    });
});

/* ============================================================
   Blocked Users
   ============================================================ */
function loadBlockedUsers() {
    var container = document.getElementById('blocked-users-list');
    if (!container) return;

    $.ajax({
        url: '/api/blocks',
        method: 'GET',
        success: function(blocks) {
            container.innerHTML = '';
            if (!blocks || blocks.length === 0) {
                container.innerHTML = '<div style="text-align:center;padding:16px;color:var(--clr-text-muted);font-size:13px;">No blocked users.</div>';
                return;
            }
            blocks.forEach(function(b) {
                var item = document.createElement('div');
                item.className = 'blocked-user-item';

                var info = document.createElement('div');
                info.className = 'blocked-user-info';

                var name = document.createElement('div');
                name.className = 'blocked-user-name';
                name.textContent = b.fullname || b.username;

                var uname = document.createElement('div');
                uname.className = 'blocked-user-username';
                uname.textContent = '@' + b.username;

                info.appendChild(name);
                info.appendChild(uname);
                item.appendChild(info);

                var unblockBtn = document.createElement('button');
                unblockBtn.className = 'unblock-btn';
                unblockBtn.innerHTML = '<i class="fi fi-sr-cross-circle"></i> Unblock';
                (function(username) {
                    unblockBtn.addEventListener('click', function() {
                        unblockUser(username, unblockBtn);
                    });
                })(b.username);

                item.appendChild(unblockBtn);
                container.appendChild(item);
            });
        },
        error: function() {
            container.innerHTML = '<div style="text-align:center;padding:16px;color:#fca5a5;font-size:13px;">Failed to load blocked users.</div>';
        }
    });
}

function unblockUser(username, btn) {
    var orig = btn.innerHTML;
    btn.innerHTML = '<i class="fi fi-rr-spinner" style="animation:spin 1s linear infinite;"></i>';
    btn.disabled = true;

    $.ajax({
        url: '/api/blocks/' + username,
        method: 'DELETE',
        headers: { 'X-XSRF-TOKEN': getCsrfToken() },
        success: function() {
            showSettingsAlert('success', 'Unblocked @' + username);
            loadBlockedUsers();
        },
        error: function(xhr) {
            showSettingsAlert('error', xhr.responseText || 'Failed to unblock.');
            btn.innerHTML = orig;
            btn.disabled = false;
        }
    });
}

/* ============================================================
   Danger Zone
   ============================================================ */
var _dangerAction = null;

$(document).on('click', '#export-data-btn', function() {
    window.open('/api/settings/export', '_blank');
});

$(document).on('click', '#clear-conversations-btn', function() {
    _dangerAction = 'clear';
    document.getElementById('danger-confirm-title').textContent = 'Clear All Conversations?';
    document.getElementById('danger-confirm-desc').textContent = 'This will permanently delete all your messages. This cannot be undone. Enter your password to confirm.';
    document.getElementById('danger-confirm-password').value = '';
    document.getElementById('danger-confirm-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(function() {
        document.getElementById('danger-confirm-password').focus();
    }, 150);
});

$(document).on('click', '#delete-account-btn', function() {
    _dangerAction = 'delete';
    document.getElementById('danger-confirm-title').textContent = 'Delete Account?';
    document.getElementById('danger-confirm-desc').textContent = 'This will permanently delete your account and all associated data. This cannot be undone. Enter your password to confirm.';
    document.getElementById('danger-confirm-password').value = '';
    document.getElementById('danger-confirm-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(function() {
        document.getElementById('danger-confirm-password').focus();
    }, 150);
});

$(document).on('click', '#danger-confirm-cancel-btn', function() {
    closeDangerModal();
});

$(document).on('click', '#danger-confirm-overlay', function(e) {
    if (e.target === this) closeDangerModal();
});

$(document).on('click', '#danger-confirm-execute-btn', function() {
    var password = document.getElementById('danger-confirm-password').value;
    if (!password) {
        showSettingsAlert('error', 'Please enter your password.');
        return;
    }

    var btn = this;
    btn.disabled = true;
    btn.innerHTML = '<i class="fi fi-rr-spinner" style="animation:spin 1s linear infinite;"></i>';

    if (_dangerAction === 'clear') {
        $.ajax({
            url: '/api/settings/conversations/all',
            method: 'DELETE',
            contentType: 'application/json',
            headers: { 'X-XSRF-TOKEN': getCsrfToken() },
            data: JSON.stringify({ password: password }),
            success: function() {
                closeDangerModal();
                showSettingsAlert('success', 'All conversations cleared.');
            },
            error: function(xhr) {
                showSettingsAlert('error', xhr.responseJSON?.error || xhr.responseText || 'Failed.');
                btn.disabled = false;
                btn.innerHTML = '<i class="fi fi-sr-trash"></i> Confirm';
                document.getElementById('danger-confirm-password').value = '';
            }
        });
    } else if (_dangerAction === 'delete') {
        $.ajax({
            url: '/api/settings/account',
            method: 'DELETE',
            contentType: 'application/json',
            headers: { 'X-XSRF-TOKEN': getCsrfToken() },
            data: JSON.stringify({ password: password }),
            success: function() {
                window.location.href = '/login';
            },
            error: function(xhr) {
                showSettingsAlert('error', xhr.responseJSON?.error || xhr.responseText || 'Failed.');
                btn.disabled = false;
                btn.innerHTML = '<i class="fi fi-sr-trash"></i> Confirm';
                document.getElementById('danger-confirm-password').value = '';
            }
        });
    }
});

function closeDangerModal() {
    document.getElementById('danger-confirm-overlay').classList.remove('open');
    document.body.style.overflow = '';
    _dangerAction = null;
    document.getElementById('danger-confirm-password').value = '';
}

function generateGroupLink(groupId, btnElement) {
    var origHtml = btnElement.innerHTML;
    btnElement.innerHTML = '<i class="fi fi-rr-spinner" style="animation:spin 1s linear infinite;"></i>';
    btnElement.disabled = true;

    $.ajax({
        url: '/api/groups/' + groupId + '/invite',
        method: 'POST',
        headers: { 'X-XSRF-TOKEN': getCsrfToken() },
        success: function(res) {
            var link = window.location.origin + '/invite/' + res.token;
            // copy to clipboard securely
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(link).then(function() {
                    btnElement.innerHTML = '<i class="fi fi-sr-check"></i> Copied';
                });
            } else {
                // fallback
                var textArea = document.createElement("textarea");
                textArea.value = link;
                textArea.style.position = "fixed";
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                try {
                    document.execCommand('copy');
                    btnElement.innerHTML = '<i class="fi fi-sr-check"></i> Copied';
                } catch (err) {
                    btnElement.innerHTML = 'Error';
                }
                document.body.removeChild(textArea);
            }
            setTimeout(function() {
                btnElement.innerHTML = origHtml;
                btnElement.disabled = false;
            }, 2000);
        },
        error: function() {
            showSettingsAlert('error', 'Failed to generate group link');
            btnElement.innerHTML = origHtml;
            btnElement.disabled = false;
        }
    });
}
