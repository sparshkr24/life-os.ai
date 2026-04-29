/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0f',
        ink: {
          primary: '#f8fafc',
          secondary: '#94a3b8',
          muted: '#64748b',
        },
        brand: {
          indigo: '#6366f1',
          violet: '#8b5cf6',
          cyan: '#06b6d4',
        },
      },
      fontFamily: {
        display: ['"Plus Jakarta Sans"', 'Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      letterSpacing: {
        tightest: '-0.04em',
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
        'brand-radial':
          'radial-gradient(circle at 30% 20%, rgba(99,102,241,0.25), transparent 60%), radial-gradient(circle at 75% 70%, rgba(139,92,246,0.18), transparent 55%)',
      },
      boxShadow: {
        glow: '0 0 60px -10px rgba(139,92,246,0.45)',
        card: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 30px 60px -30px rgba(0,0,0,0.6)',
      },
      animation: {
        'orb-drift': 'orbDrift 18s ease-in-out infinite',
        'orb-drift-slow': 'orbDrift 28s ease-in-out infinite',
        'pulse-soft': 'pulseSoft 6s ease-in-out infinite',
      },
      keyframes: {
        orbDrift: {
          '0%, 100%': { transform: 'translate3d(0,0,0) scale(1)' },
          '50%': { transform: 'translate3d(40px,-30px,0) scale(1.08)' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '0.55' },
          '50%': { opacity: '0.85' },
        },
      },
    },
  },
  plugins: [],
};
