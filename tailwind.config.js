/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#0B1020",
        surface: "#111A2E",
        card: "#162238",
        border: "#263650",
        foreground: "#EAF2FF",
        muted: "#91A4C3",
        accent: "#22D3EE",
        indigo: "#818CF8",
        violet: "#A78BFA",
        success: "#34D399",
        warning: "#FBBF24",
        danger: "#FB7185",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      borderRadius: {
        lg: "0.625rem",
        md: "0.5rem",
        sm: "0.375rem",
      },
      boxShadow: {
        card: "0 1px 2px rgba(2, 6, 17, 0.4), 0 4px 16px rgba(2, 6, 17, 0.25)",
      },
    },
  },
  plugins: [],
};
