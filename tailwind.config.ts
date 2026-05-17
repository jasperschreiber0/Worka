import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // WorkA brand palette — earthy, professional, trade-grade
        brand: {
          50:  '#fdf8f0',
          100: '#faefd9',
          200: '#f4dbb0',
          300: '#ecc07d',
          400: '#e29f48',
          500: '#d88428',   // primary orange
          600: '#c46a1e',
          700: '#a3521a',
          800: '#84421c',
          900: '#6c381a',
          950: '#3d1c0b',
        },
        slate: {
          850: '#1e2837',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '0.5rem',
      },
    },
  },
  plugins: [],
}

export default config
