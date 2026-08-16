/**
 * Without this file Next emits globals.css verbatim — the CSS variables survive
 * but every Tailwind utility class is dropped, so the app renders unstyled.
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
