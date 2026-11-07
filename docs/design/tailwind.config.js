/** Replenish · Round 6 — theme.extend (mirrors tokens.css) */
module.exports = {
  theme: {
    extend: {
      colors: {
        bg: '#F6F3EE', surface: '#EEE9E1', 'surface-2': '#E8E2D8', raised: '#FFFFFF', line: '#E3DDD3',
        ink: { DEFAULT: '#1C1B19', 2: '#5E5A54', 3: '#938E86' },
        teal: { DEFAULT: '#1F6B63', press: '#18564F', soft: '#DDEAE5' },
        green: '#2F8A68',
        warn: { DEFAULT: '#C4562E', soft: '#F7E6DC', surface: '#F8EDE5' },
        blue: { DEFAULT: '#3C6A8F', soft: '#E3EAEF' },
        paypal: { navy: '#003087', blue: '#0070E0' },
        sandbox: '#C9A227',
      },
      fontFamily: {
        serif: ['Newsreader', 'Georgia', 'serif'],
        sans: ['Inter', '-apple-system', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        headline: ['31px', { lineHeight: '36px', letterSpacing: '-0.025em', fontWeight: '420' }],
        'dog-name': ['26px', { lineHeight: '26px', letterSpacing: '-0.015em', fontWeight: '450' }],
        'limit-value': ['22px', { lineHeight: '22px', letterSpacing: '-0.01em', fontWeight: '500' }],
        delta: ['24px', { lineHeight: '24px', letterSpacing: '-0.025em', fontWeight: '600' }],
        reason: ['15px', { lineHeight: '22px', fontWeight: '400' }],
        body: ['15px', { lineHeight: '20px', fontWeight: '500' }],
        'body-sm': ['14px', { lineHeight: '20px', fontWeight: '400' }],
        caption: ['12.5px', { lineHeight: '16px', fontWeight: '400' }],
        pill: ['12px', { lineHeight: '12px', fontWeight: '500' }],
        'tile-day': ['17px', { lineHeight: '20px', fontWeight: '500' }],
        'tile-label': ['8.5px', { lineHeight: '10px', fontWeight: '500' }],
      },
      spacing: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '20px', 6: '24px', 8: '32px', 10: '40px', 12: '48px' },
      borderRadius: { sm: '8px', md: '12px', lg: '16px', xl: '24px', sheet: '28px', pill: '999px' },
      boxShadow: {
        input: '0 1px 2px rgba(28,27,25,.04), 0 6px 20px rgba(28,27,25,.07)',
        sheet: '0 -8px 32px rgba(28,27,25,.10)',
        avatar: '0 0 0 4px #FFFFFF, 0 4px 16px rgba(28,27,25,.10)',
      },
    },
  },
};
