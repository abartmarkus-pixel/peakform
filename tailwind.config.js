/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#edfdf6',
          100: '#d3f9ea',
          200: '#aaf1d6',
          300: '#72e4bb',
          400: '#38ce9b',
          500: '#1D9E75',
          600: '#0f8762',
          700: '#0d6d50',
          800: '#0d5741',
          900: '#0c4836',
        },
      },
    },
  },
  plugins: [],
}
