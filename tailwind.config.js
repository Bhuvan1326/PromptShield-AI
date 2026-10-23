/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#0C111B",
        surface: "#121A27",
        card: "#182333",
        border: "#2A384B",
        foreground: "#E5ECF5",
        muted: "#95A4B8",
        accent: "#5EEAD4",
        indigo: "#91A7FF",
        violet: "#91A7FF",
        success: "#5EEAD4",
        warning: "#F6C96B",
        danger: "#FF7185",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      borderRadius: {
        lg: "0.5rem",
        md: "0.375rem",
        sm: "0.25rem",
      },
      boxShadow: {
        card: "none",
      },
    },
  },
  plugins: [],
};
