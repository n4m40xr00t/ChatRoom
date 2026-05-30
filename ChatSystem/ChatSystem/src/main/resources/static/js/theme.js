/**
 * theme.js — applies the user's saved theme instantly on every page.
 *
 * The server already sets data-theme and data-chatbg on <html> via Thymeleaf,
 * so on authenticated pages there is zero flash. This script is a safety net
 * for pages where the server hasn't injected the attributes (e.g. login page),
 * falling back to localStorage so the preference persists client-side too.
 *
 * Load this as the FIRST script in <head> (no defer) to avoid FOUC.
 */
(function () {
    var VALID_THEMES  = ['dark','midnight','ocean','forest','rose','slate'];
    var VALID_CHATBGS = ['none','dots','grid','waves','bubbles'];

    var html = document.documentElement;

    // If server already set the attribute, sync it to localStorage and stop.
    var serverTheme  = html.getAttribute('data-theme');
    var serverChatBg = html.getAttribute('data-chatbg');

    if (serverTheme && VALID_THEMES.indexOf(serverTheme) !== -1) {
        try { localStorage.setItem('cr_theme', serverTheme); } catch(e){}
    } else {
        // Fallback: read from localStorage (unauthenticated pages like /login)
        var stored = '';
        try { stored = localStorage.getItem('cr_theme') || ''; } catch(e){}
        if (VALID_THEMES.indexOf(stored) !== -1) {
            html.setAttribute('data-theme', stored);
        } else {
            html.setAttribute('data-theme', 'dark');
        }
    }

    if (serverChatBg && VALID_CHATBGS.indexOf(serverChatBg) !== -1) {
        try { localStorage.setItem('cr_chatbg', serverChatBg); } catch(e){}
    } else {
        var storedBg = '';
        try { storedBg = localStorage.getItem('cr_chatbg') || ''; } catch(e){}
        if (VALID_CHATBGS.indexOf(storedBg) !== -1) {
            html.setAttribute('data-chatbg', storedBg);
        } else {
            html.setAttribute('data-chatbg', 'bubbles');
        }
    }
})();
