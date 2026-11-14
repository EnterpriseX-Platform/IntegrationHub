/** @type {import('tailwindcss').Config} */
// IBM Carbon Design System theme (g10 / white).
// Every Tailwind palette the app uses is remapped onto the Carbon palette, so
// existing utility classes (bg-blue-600, text-gray-500, ...) render as Carbon.

const carbon = {
  gray: ['#f4f4f4', '#e0e0e0', '#c6c6c6', '#a8a8a8', '#8d8d8d', '#6f6f6f', '#525252', '#393939', '#262626', '#161616'],
  blue: ['#edf5ff', '#d0e2ff', '#a6c8ff', '#78a9ff', '#4589ff', '#0f62fe', '#0043ce', '#002d9c', '#001d6c', '#001141'],
  red: ['#fff1f1', '#ffd7d9', '#ffb3b8', '#ff8389', '#fa4d56', '#da1e28', '#a2191f', '#750e13', '#520408', '#2d0709'],
  green: ['#defbe6', '#a7f0ba', '#6fdc8c', '#42be65', '#24a148', '#198038', '#0e6027', '#044317', '#022d0d', '#071908'],
  yellow: ['#fcf4d6', '#fddc69', '#f1c21b', '#d2a106', '#b28600', '#8e6a00', '#684e00', '#483700', '#302400', '#1c1500'],
  orange: ['#fff2e8', '#ffd9be', '#ffb784', '#ff832b', '#eb6200', '#ba4e00', '#8a3800', '#5e2900', '#3e1a00', '#231000'],
  purple: ['#f6f2ff', '#e8daff', '#d4bbff', '#be95ff', '#a56eff', '#8a3ffc', '#6929c4', '#491d8b', '#31135e', '#1c0f30'],
  cyan: ['#e5f6ff', '#bae6ff', '#82cfff', '#33b1ff', '#1192e8', '#0072c3', '#00539a', '#003a6d', '#012749', '#061727'],
  teal: ['#d9fbfb', '#9ef0f0', '#3ddbd9', '#08bdba', '#009d9a', '#007d79', '#005d5d', '#004144', '#022b30', '#081a1c'],
  magenta: ['#fff0f7', '#ffd6e8', '#ffafd2', '#ff7eb6', '#ee5396', '#d02670', '#9f1853', '#740937', '#510224', '#2a0a18'],
};

// Each palette points at CSS variables in src/carbon-theme.css so the
// light (g10) and dark (g100) Carbon themes can be swapped at runtime.
const v = (n) => Object.fromEntries(
  [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((s) => [s, `rgb(var(--c-${n}-${s}) / <alpha-value>)`])
);
const blue = v('blue');
const gray = v('gray');

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans"', '"IBM Plex Sans Thai"', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        brand: carbon.blue[5],
        layer: 'rgb(var(--c-layer) / <alpha-value>)',
        gray, slate: gray, zinc: gray, neutral: gray, stone: gray,
        blue, sky: blue, indigo: blue,
        red: v('red'), rose: v('red'),
        green: v('green'), emerald: v('green'), lime: v('green'),
        yellow: v('yellow'), amber: v('yellow'),
        orange: v('orange'),
        purple: v('purple'), violet: v('purple'), fuchsia: v('purple'),
        pink: v('magenta'),
        cyan: v('cyan'),
        teal: v('teal'),
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
      },
      // Carbon is square: no rounded corners except pills/avatars (rounded-full)
      borderRadius: {
        none: '0', sm: '0', DEFAULT: '0', md: '0', lg: '0', xl: '0', '2xl': '0', '3xl': '0',
      },
      boxShadow: {
        sm: '0 1px 2px rgb(0 0 0 / 0.12)',
        DEFAULT: '0 2px 6px rgb(0 0 0 / 0.2)',
        md: '0 2px 6px rgb(0 0 0 / 0.2)',
        lg: '0 2px 6px rgb(0 0 0 / 0.3)',
        xl: '0 4px 8px rgb(0 0 0 / 0.3)',
        '2xl': '0 4px 8px rgb(0 0 0 / 0.3)',
      },
    },
  },
  plugins: [],
}
