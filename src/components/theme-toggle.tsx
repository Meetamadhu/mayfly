"use client";

export function ThemeToggle({
  theme,
  onChange,
}: {
  theme: "light" | "dark";
  onChange: (next: "light" | "dark") => void;
}) {
  return (
    <div className="theme-toggle" role="group" aria-label="Color theme">
      <button type="button" aria-label="Light" aria-pressed={theme === "light"} onClick={() => onChange("light")}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
          <path
            d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <button type="button" aria-label="Dark" aria-pressed={theme === "dark"} onClick={() => onChange("dark")}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            d="M21 14.5A8.5 8.5 0 1 1 9.5 3a7 7 0 0 0 11.5 11.5z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}
