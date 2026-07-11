// Appearance preference: "system" (follow the OS), "light", or "dark".
// Persisted in localStorage; "system" is represented by the absence of the key, so the
// no-flash inline script in index.html only has to look for an explicit light/dark.

const STORAGE_KEY = "theme";
const VALID = ["system", "light", "dark"];

export function getStoredTheme() {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    return VALID.includes(t) ? t : "system";
  } catch {
    return "system";
  }
}

// Forces the appearance by setting `color-scheme` (via a data-theme attribute the CSS
// keys off), or hands control back to the OS when "system". The CSS tokens use
// light-dark(), so flipping color-scheme is all that's needed to re-theme everything.
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") {
    root.setAttribute("data-theme", theme);
  } else {
    root.removeAttribute("data-theme");
  }
  try {
    if (theme === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures (e.g. private mode) — the in-memory choice still applies.
  }
}
