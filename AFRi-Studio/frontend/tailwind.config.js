/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink:   { 900:'#0B0D10', 850:'#0F1216', 800:'#14181D', 750:'#191E24',
                 700:'#1F252C', 600:'#2A323B', 500:'#3A444F', 400:'#55626F' },
        mute:  { 500:'#7C8A99', 400:'#98A5B3', 300:'#B8C3CE' },
        marigold: { 600:'#C9700A', 500:'#E8890C', 400:'#F2A007', 300:'#FFBC3D', 200:'#FFD583' },
        jade:  { 500:'#2FA37A', 400:'#3DBE8F' },
        rose:  { 500:'#D65A5A', 400:'#E87676' },
        sky:   { 500:'#4A90D9', 400:'#6BA9E8' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      keyframes: {
        'fade-in': { '0%': { opacity: '0', transform: 'translateY(4px)' },
                     '100%': { opacity: '1', transform: 'translateY(0)' } },
        'pulse-soft': { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.45' } },
        'slide-in': { '0%': { opacity:'0', transform:'translateX(-6px)' },
                      '100%': { opacity:'1', transform:'translateX(0)' } },
      },
      animation: {
        'fade-in': 'fade-in 0.22s ease-out',
        'pulse-soft': 'pulse-soft 1.8s ease-in-out infinite',
        'slide-in': 'slide-in 0.2s ease-out',
      },
    },
  },
  plugins: [],
}
