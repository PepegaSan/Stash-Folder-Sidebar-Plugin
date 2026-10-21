/**
 * Tiny i18n: English text is the key, other languages map it (src/locales/<lang>.ts). The language is
 * resolved once before the editor renders (Stash UI's choice, then Stash's interface language, then the
 * browser), so t() can stay a plain function. `tools/i18n-check.mjs` lists keys a language is missing.
 */
import de from "./locales/de";

export type Lang = "en" | "de";

const DICTS: Record<Lang, Record<string, string>> = { en: {}, de };
let current: Lang = "en";

export const getLang = (): Lang => current;

/** "de", "de-DE", "German" … -> de; anything else -> en. */
export function setLang(code: string | null | undefined): Lang {
  current = /^de\b/i.test((code ?? "").trim()) ? "de" : "en";
  return current;
}

export function t(text: string, vars?: Record<string, string | number>): string {
  let s = DICTS[current][text] ?? text;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** A count with its noun: tn(n, "{n} clips", "1 clip") – both texts are keys. */
export function tn(n: number, many: string, one: string): string {
  return n === 1 ? t(one) : t(many, { n });
}

/**
 * Where the language comes from: Stash UI's own setting (when the editor runs inside it), otherwise
 * Stash's interface language; the browser decides when neither says anything.
 */
export async function detectLang(opts: { stashui: boolean; interfaceLanguage: () => Promise<string | null> }): Promise<Lang> {
  if (opts.stashui) {
    try {
      const chosen = localStorage.getItem("stashui.lang");
      if (chosen && chosen !== "auto") return setLang(chosen.replace(/^"|"$/g, ""));
    } catch {
      /* storage blocked */
    }
  }
  let code: string | null = null;
  try {
    code = await opts.interfaceLanguage();
  } catch {
    /* no Stash – browser language */
  }
  return setLang(code || navigator.language);
}
