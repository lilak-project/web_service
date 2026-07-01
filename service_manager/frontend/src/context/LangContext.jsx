import { createContext, useContext, useState, useCallback } from 'react'
import ko from '../i18n/ko'
import en from '../i18n/en'

// Minimal i18n — same `t()` semantics as elog (function values interpolate,
// missing keys fall back to English then to the key itself), but without elog's
// per-user preference plumbing. Language is just a localStorage toggle.
const DICTS = { ko, en }
const LangContext = createContext(null)

export function LangProvider({ children }) {
  const [lang, setLang] = useState(() => localStorage.getItem('sm_lang') || 'en')

  const set = useCallback((l) => { setLang(l); localStorage.setItem('sm_lang', l) }, [])
  const toggle = useCallback(() => set(lang === 'en' ? 'ko' : 'en'), [lang, set])

  function t(key, ...args) {
    const val = DICTS[lang]?.[key] ?? DICTS['en']?.[key] ?? key
    return typeof val === 'function' ? val(...args) : val
  }

  return (
    <LangContext.Provider value={{ lang, toggle, set, t }}>
      {children}
    </LangContext.Provider>
  )
}

export function useLang() { return useContext(LangContext) }
