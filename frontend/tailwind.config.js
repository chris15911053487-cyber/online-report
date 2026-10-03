/**
 * 颜色只提供语义色（取自 src/theme/themes.css 的 CSS 变量），不提供 slate / sky 等原始调色板：
 * 组件写不出写死的颜色，切换主题时全站自动跟随。新增颜色先在 themes.css 六套主题里补 token，再在这里登记。
 */
const v = (name) => `rgb(var(--c-${name}) / <alpha-value>)`

const semantic = {
  bg: v('bg'),
  surface: { DEFAULT: v('surface'), 2: v('surface-2'), 3: v('surface-3') },
  line: { DEFAULT: v('line'), strong: v('line-strong') },
  fg: { DEFAULT: v('fg'), 2: v('fg-2') },
  muted: v('muted'),
  subtle: v('subtle'),
  primary: { DEFAULT: v('primary'), hover: v('primary-hover'), fg: v('primary-fg'), soft: v('primary-soft') },
  accent: { DEFAULT: v('accent'), soft: v('accent-soft') },
  success: { DEFAULT: v('success'), soft: v('success-soft') },
  warning: { DEFAULT: v('warning'), soft: v('warning-soft') },
  danger: { DEFAULT: v('danger'), soft: v('danger-soft') },
  info: { DEFAULT: v('info'), soft: v('info-soft') },
  inverse: { DEFAULT: v('inverse'), fg: v('inverse-fg') },
  chrome: {
    DEFAULT: v('chrome'),
    fg: v('chrome-fg'),
    muted: v('chrome-muted'),
    line: v('chrome-line'),
    active: v('chrome-active'),
    'active-bg': v('chrome-active-bg'),
    side: v('side'),
  },
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      inherit: 'inherit',
      // 仅用于主色/状态色实底上的文字与遮罩层
      white: '#ffffff',
      black: '#000000',
      ...semantic,
    },
    extend: {
      // 文字用的主色在深色主题下需要更亮，与按钮底色分开
      textColor: { primary: { DEFAULT: v('primary-text'), fg: v('primary-fg') } },
      borderRadius: {
        lg: 'var(--radius-control)',
        xl: 'var(--radius-card)',
        '2xl': 'var(--radius-card-lg)',
        control: 'var(--radius-control)',
        card: 'var(--radius-card)',
      },
      boxShadow: {
        sm: 'var(--shadow-card)',
        DEFAULT: 'var(--shadow-card)',
        card: 'var(--shadow-card)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        display: ['var(--font-display)'],
        num: ['var(--font-num)'],
      },
      backgroundImage: {
        ai: 'var(--ai-gradient)',
      },
    },
  },
  plugins: [],
}
