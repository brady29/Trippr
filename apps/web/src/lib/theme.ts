/**
 * Day / Night / System. "System" follows the device; the other two pin the
 * choice by setting data-theme on <html>, which globals.css reads.
 */
export type ThemeChoice = "system" | "light" | "dark";

const KEY = "trippr.theme";

/** Runs before first paint (inlined in the root layout) so a pinned theme never flashes. */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export function readTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Private windows can refuse storage; the choice still applies until reload.
  }
}
