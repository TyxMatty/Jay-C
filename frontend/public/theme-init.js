// Runs before CSS paints. Keep in sync with resolveTheme() in src/ui/theme.js.
(function () {
  var theme = 'light';
  try {
    var pref = JSON.parse(localStorage.getItem('jayc.settings') || '{}').theme || 'system';
    var dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    theme = dark ? 'dark' : 'light';
  } catch (e) {}
  document.documentElement.dataset.theme = theme;
})();
