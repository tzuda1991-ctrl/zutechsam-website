(() => {
  const root = document.documentElement;
  try {
    const saved = localStorage.getItem('zu-theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (saved === 'dark' || (!saved && prefersDark)) {
      root.classList.add('dark');
    }
  } catch {}

  function syncThemeMeta() {
    const dark = root.classList.contains('dark');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0b1120' : '#f8fafc');
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(dark));
      const label = btn.querySelector('[data-theme-label]');
      if (label) label.textContent = dark ? 'Light mode' : 'Dark mode';
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    syncThemeMeta();

    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dark = root.classList.toggle('dark');
        try {
          localStorage.setItem('zu-theme', dark ? 'dark' : 'light');
        } catch {}
        syncThemeMeta();
      });
    });

    // Offline connectivity indicator
    const offlineBanner = document.getElementById('offlineBanner');
    function syncOnline() {
      if (!offlineBanner) return;
      offlineBanner.hidden = navigator.onLine !== false;
    }
    window.addEventListener('online', syncOnline);
    window.addEventListener('offline', syncOnline);
    syncOnline();

    // Service Worker registration
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    }

    // PWA Install prompt + iOS Safari fallback
    let deferredPrompt = null;
    const installBtns = [...document.querySelectorAll('[data-pwa-install]')];
    const iosDialog = document.getElementById('iosInstallDialog');
    const iosClose = document.getElementById('iosInstallClose');
    const isStandalone =
      window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone === true;
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent || '') && !window.MSStream;

    function refreshInstallButtons() {
      const canShow = !isStandalone && (!!deferredPrompt || isIos);
      installBtns.forEach((b) => {
        b.hidden = !canShow;
      });
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      refreshInstallButtons();
    });

    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      installBtns.forEach((b) => {
        b.hidden = true;
      });
    });

    installBtns.forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          await deferredPrompt.userChoice.catch(() => {});
          deferredPrompt = null;
          refreshInstallButtons();
        } else if (isIos && iosDialog) {
          iosDialog.showModal();
        }
      });
    });

    if (iosClose && iosDialog) {
      iosClose.addEventListener('click', () => iosDialog.close());
      iosDialog.addEventListener('click', (e) => {
        if (e.target === iosDialog) iosDialog.close();
      });
    }

    refreshInstallButtons();
  });
})();
