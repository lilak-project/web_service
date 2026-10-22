// author manager's words, in the shared dictionary (lilak-ui i18n). Imported
// first by every module here, so its entries exist before the service's
// definition is read. Adding a language: add i18n/<lang>.js and list it here.
import { addStrings } from 'lilak-ui'
import ko from './i18n/ko.js'
import en from './i18n/en.js'

addStrings({ ko, en })
