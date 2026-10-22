import { LangProvider as KitLangProvider, useLang as useKitLang, addStrings } from 'lilak-ui'
import ko from '../i18n/ko'
import en from '../i18n/en'

// The portal's strings, in the kit's one registry — the same mechanism elog's
// t() and every rack service use, so one language choice covers them all.
// Adding a language = adding ../i18n/<lang>.js here.
addStrings({ ko, en })

export function LangProvider({ children }) {
  return <KitLangProvider defaultLang="en">{children}</KitLangProvider>
}

export function useLang() { return useKitLang() }
