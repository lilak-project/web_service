// Purple main theme for lilak_gui. Same mechanism as the kit's Teal preset
// (see lilak_ui/src/theme/presets.js): a preset's "main color" drives BOTH the
// accent tokens (buttons / links / focus / info) AND the top bar + bottom command
// bar (nav-* tokens). Here the main color is purple (#9333ea family).
import { setTokenOverride } from 'lilak-ui'

export const PURPLE = {
  // accents
  'btn-primary-bg': '#9333ea', 'btn-primary-hover': '#7e22ce', 'btn-primary-text': '#ffffff',
  'text-link': '#9333ea', 'text-link-hover': '#7e22ce',
  'border-focus': '#9333ea', 'input-focus-border': '#9333ea',
  'info-bg': '#f3e8ff', 'info-text': '#7e22ce',
  'selection-bg': 'rgba(147,51,234,0.28)',
  // top bar + bottom command bar = the main color
  'nav-bg': '#9333ea', 'nav-border': '#7e22ce', 'nav-accent': '#7e22ce',
  'nav-text': '#ffffff', 'nav-text-muted': '#e9d5ff',
}

/** Apply the purple overrides on top of the active base theme. Call after
 *  applyTheme(). Re-applies cleanly because each token is set individually. */
export function applyPurple() {
  for (const [name, value] of Object.entries(PURPLE)) setTokenOverride(name, value)
}

// Themes offered in the UI. Only 'bright' for now: the purple main color is fixed
// (the nav + accent tokens are overridden regardless of base theme), so
// 'dark'/'lowcontrast' barely change anything. Re-add their ids here to bring the
// options back.
export const ENABLED_THEMES = ['bright']

