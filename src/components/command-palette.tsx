"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type PaletteCommand = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  /** Where to go, or a function to run. */
  run: () => void;
  /** Keywords beyond the label. */
  keywords?: string[];
  /** Admin-only commands stay hidden until signed in. */
  admin?: boolean;
};

/**
 * Ctrl/Cmd+K command palette: jump to a page, toggle theme, open New preview, and a few admin shortcuts.
 * One global listener; pages register extra commands through the optional `extra` prop on the shell.
 */
export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? commands.filter((command) => {
          const hay = `${command.label} ${command.hint ?? ""} ${command.group} ${(command.keywords ?? []).join(" ")}`.toLowerCase();
          return q.split(/\s+/).every((part) => hay.includes(part));
        })
      : commands;
    return list.slice(0, 12);
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    const item = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [active, filtered.length]);

  if (!open) return null;

  function go(index: number) {
    const command = filtered[index];
    if (!command) return;
    onClose();
    command.run();
  }

  return (
    <div className="cmdk" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="cmdk-panel" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          className="cmdk-input"
          value={query}
          placeholder="Go somewhere or run a command…"
          aria-controls="cmdk-list"
          aria-activedescendant={filtered[active] ? `cmdk-${filtered[active].id}` : undefined}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((value) => Math.min(filtered.length - 1, value + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              go(active);
            }
          }}
        />
        <ul id="cmdk-list" className="cmdk-list" role="listbox" ref={listRef}>
          {filtered.length === 0 ? <li className="cmdk-empty">Nothing matches.</li> : null}
          {filtered.map((command, index) => (
            <li key={command.id} role="option" id={`cmdk-${command.id}`} aria-selected={index === active} data-index={index}>
              <button
                type="button"
                className="cmdk-item"
                data-active={index === active || undefined}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(index)}
              >
                <span className="cmdk-item-label">{command.label}</span>
                <span className="cmdk-item-meta">{command.hint ?? command.group}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="cmdk-foot">
          <kbd>↑</kbd>
          <kbd>↓</kbd> move · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close
        </p>
      </div>
    </div>
  );
}

export function defaultPaletteCommands(options: {
  signedIn: boolean;
  theme: "light" | "dark";
  onTheme: (theme: "light" | "dark") => void;
  onNewPreview?: () => void;
}): PaletteCommand[] {
  const go = (href: string) => () => {
    window.location.assign(href);
  };
  const pages: PaletteCommand[] = [
    { id: "board", label: "Previews", group: "Go to", hint: "Board", run: go("/board"), keywords: ["dashboard", "home"] },
    { id: "activity", label: "Activity", group: "Go to", run: go("/activity") },
    { id: "cost", label: "Cost", group: "Go to", run: go("/cost"), keywords: ["budget", "savings"] },
    { id: "pricing", label: "Pricing", group: "Go to", run: go("/pricing") },
    { id: "admin", label: "Admin", group: "Go to", run: go("/admin"), admin: true },
    { id: "ops", label: "Health & ops", group: "Go to", run: go("/ops"), admin: true, keywords: ["metrics", "audit"] },
    { id: "policies", label: "Lifetime rules", group: "Go to", run: go("/policies"), admin: true },
    { id: "settings", label: "Preview settings", group: "Go to", run: go("/preview-settings"), admin: true, keywords: ["secrets", "env"] },
    { id: "comments", label: "PR comments", group: "Go to", run: go("/pr-comments"), admin: true },
  ];
  const actions: PaletteCommand[] = [
    {
      id: "theme-toggle",
      label: options.theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
      group: "Actions",
      run: () => options.onTheme(options.theme === "dark" ? "light" : "dark"),
      keywords: ["theme", "appearance"],
    },
  ];
  if (options.signedIn && options.onNewPreview) {
    actions.unshift({
      id: "new-preview",
      label: "New preview",
      group: "Actions",
      run: options.onNewPreview,
      keywords: ["create", "open"],
      admin: true,
    });
  }
  if (!options.signedIn) {
    pages.push({ id: "login", label: "Sign in", group: "Go to", run: go("/admin/login"), keywords: ["admin"] });
  }
  return [...pages, ...actions].filter((command) => !command.admin || options.signedIn);
}
