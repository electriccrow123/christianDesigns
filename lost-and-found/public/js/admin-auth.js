/* =============================================================================
   ADMIN LOGIN (shared by admin.html and admin-deals.html)
   Shows a password box. Once the right password is entered (checked by the
   server against ADMIN_PASSWORD), the admin area (#admin-app) is shown and
   the page's own code runs. The password is kept only for this browser tab.
   ============================================================================= */
LF.adminLogin = function (onReady) {
  const loginBox = document.getElementById('login');
  const app = document.getElementById('admin-app');

  async function tryLogin(password) {
    LF.adminPassword.set(password);
    try {
      await LF.api('/api/login', { method: 'POST', admin: true });
      loginBox.classList.add('hidden');
      app.classList.remove('hidden');
      onReady();
      return true;
    } catch {
      LF.adminPassword.clear();
      return false;
    }
  }

  loginBox.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await tryLogin(loginBox.querySelector('input').value);
    loginBox.querySelector('.notice').classList.toggle('hidden', ok);
  });

  document.getElementById('logout')?.addEventListener('click', () => { LF.adminPassword.clear(); location.reload(); });

  // Already logged in during this tab? Skip the password box.
  if (LF.adminPassword.get()) tryLogin(LF.adminPassword.get());
};
