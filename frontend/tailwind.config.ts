import type { Config } from 'tailwindcss';

// Theme from the design's Tokens.dc.html ("Tailwind 3 theme"). The values live
// in src/styles/tokens.css as RGB channels so the alpha modifier works.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--bg) / <alpha-value>)',
        surface: {
          1: 'rgb(var(--s1) / <alpha-value>)',
          2: 'rgb(var(--s2) / <alpha-value>)',
          3: 'rgb(var(--s3) / <alpha-value>)',
        },
        line: { DEFAULT: 'rgb(var(--bd))', strong: 'rgb(var(--bd2))' },
        ink: { DEFAULT: 'rgb(var(--tx))', muted: 'rgb(var(--tx2))', faint: 'rgb(var(--tx3))' },
        accent: { DEFAULT: 'rgb(var(--ac) / <alpha-value>)', ink: 'rgb(var(--ac-ink))' },
        ok: 'rgb(var(--ok) / <alpha-value>)', // bg-ok/12 = tint
        warn: 'rgb(var(--warn) / <alpha-value>)',
        crit: 'rgb(var(--crit) / <alpha-value>)',
        off: 'rgb(var(--off) / <alpha-value>)',
        series: { 1: 'rgb(var(--s-in))', 2: 'rgb(var(--s-out))' },
        // The design's remaining tokens (accent-soft, status tints, dialog
        // scrim). Their alpha differs per theme and the light warn tint has its
        // own hue, so `bg-warn/13` cannot reproduce them in both themes.
        tint: {
          accent: 'rgb(var(--ac-soft))',
          ok: 'rgb(var(--ok-bg))',
          warn: 'rgb(var(--warn-bg))',
          crit: 'rgb(var(--crit-bg))',
          off: 'rgb(var(--off-bg))',
        },
        scrim: 'rgb(var(--scrim))',
      },
      fontFamily: {
        sans: ['Geist', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        cap: ['12px', '16px'],
        sm: ['13px', '18px'],
        base: ['14px', '20px'],
        h3: ['16px', '24px'],
        h2: ['20px', '28px'],
        h1: ['24px', '32px'],
        display: ['32px', '40px'],
        metric: ['28px', '32px'],
      },
      borderRadius: { sm: '4px', DEFAULT: '6px', lg: '8px', xl: '12px' },
      boxShadow: { float: 'var(--shadow)' },
      transitionDuration: { tick: '400ms', shift: '600ms' },
    },
  },
  plugins: [],
} satisfies Config;
