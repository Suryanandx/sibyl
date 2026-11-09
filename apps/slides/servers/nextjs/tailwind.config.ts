import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],

  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "!./app/privacy-policy/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // Sibyl tokens (app/sibyl.css) drive every UI color, light and dark.
      colors: {
        background: "var(--bg)",
        foreground: "var(--text)",
        card: {
          DEFAULT: "var(--surface)",
          foreground: "var(--text)",
        },
        popover: {
          DEFAULT: "var(--surface)",
          foreground: "var(--text)",
        },
        primary: {
          DEFAULT: "var(--ink)",
          foreground: "var(--ink-text)",
        },
        secondary: {
          DEFAULT: "var(--subtle)",
          foreground: "var(--text)",
        },
        muted: {
          DEFAULT: "var(--subtle)",
          foreground: "var(--text-2)",
        },
        accent: {
          DEFAULT: "var(--hover)",
          foreground: "var(--text)",
        },
        destructive: {
          DEFAULT: "var(--danger)",
          foreground: "var(--ink-text)",
        },
        border: "var(--border)",
        input: "var(--border-strong)",
        ring: "var(--accent)",
        sibyl: {
          bg: "var(--bg)",
          canvas: "var(--canvas)",
          surface: "var(--surface)",
          subtle: "var(--subtle)",
          hover: "var(--hover)",
          text: "var(--text)",
          "text-2": "var(--text-2)",
          "text-3": "var(--text-3)",
          border: "var(--border)",
          "border-strong": "var(--border-strong)",
          ink: "var(--ink)",
          "ink-hover": "var(--ink-hover)",
          "ink-text": "var(--ink-text)",
          accent: "var(--accent)",
          "accent-soft": "var(--accent-soft)",
          danger: "var(--danger)",
        },
        chart: {
          "1": "hsl(var(--chart-1))",
          "2": "hsl(var(--chart-2))",
          "3": "hsl(var(--chart-3))",
          "4": "hsl(var(--chart-4))",
          "5": "hsl(var(--chart-5))",
        },
      },
      borderRadius: {
        lg: "var(--radius-md)",
        md: "10px",
        sm: "var(--radius-sm)",
      },
      keyframes: {
        "accordion-down": {
          from: {
            height: "0",
          },
          to: {
            height: "var(--radix-accordion-content-height)",
          },
        },
        "accordion-up": {
          from: {
            height: "var(--radix-accordion-content-height)",
          },
          to: {
            height: "0",
          },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
      fontFamily: {
        syne: ["var(--font-syne)"],
        manrope: ["var(--font-manrope)"],
      },
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    require("@tailwindcss/typography"),
  ],
};
export default config;
