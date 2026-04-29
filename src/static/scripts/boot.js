// boot.js — Top-level page-load IIFE: first-run → wizard, authed → app, unauthed → /login.
// Loaded LAST so every dependency (onboarding, auth, app) is already in scope.
// Extracted from src/static/scripts/app.js (was lines 3387-3400 of the post-Phase-2 monolith).

// Bootstrap: first-run → operator wizard; authed → slim wizard if needed else
// the app; unauthed → bounce to /login (the standalone page handles credentials
// and registration, then redirects back here).
(async () => {
  if (window.__ONBOARDING__?.needed) { startOnboarding(); return; }
  const auth = await checkAuthState();
  if (!auth.ok) {
    const base = (window.location.pathname || '/').replace(/\/(graph|index\.html|login)?\/?$/, '');
    window.location.replace((base || '') + '/login');
    return;
  }
  if (auth.wizardNeeded) { startUserWizard(); return; }
  showApp();
})();
