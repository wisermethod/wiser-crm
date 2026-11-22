import { useEffect, useState } from "react";

export const defaultBrandName = "Wiser CRM";

const colorRole = /^(?:accent-(?:brand|text|tint)|primary(?:-foreground|-hover|-edge|-focus-inner)?|ring)$/;
const fittedHex = /^#[0-9a-f]{6}$/;

function declarations(tokens: unknown): string {
  if (!tokens || typeof tokens !== "object") return "";
  return Object.entries(tokens)
    .filter(([role, value]) => colorRole.test(role) && typeof value === "string" && fittedHex.test(value))
    .map(([role, value]) => `--${role}:${value};`)
    .join("");
}

export function useInstallBrand(): string | null {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    const request = new AbortController();
    const timeout = window.setTimeout(() => request.abort(), 5_000);
    const overrides = document.createElement("style");
    let mounted = true;

    async function load() {
      let name = defaultBrandName;
      try {
        const response = await fetch("/api/wiser/brand", { signal: request.signal, cache: "no-store" });
        if (response.ok) {
          const brand = await response.json() as {
            name?: unknown;
            accent?: { light?: unknown; dark?: unknown };
          } | null;
          if (!mounted) return;
          if (typeof brand?.name === "string" && brand.name) name = brand.name;
          const light = declarations(brand?.accent?.light);
          const dark = declarations(brand?.accent?.dark);
          if (light && dark) {
            overrides.textContent = `:root{${light}}.dark{${dark}}`;
            document.head.appendChild(overrides);
          }
        }
      } catch {
        // The installed Mist stylesheet supplies the full fallback.
      } finally {
        window.clearTimeout(timeout);
        if (mounted) {
          document.title = name === defaultBrandName ? name : `${name} · ${defaultBrandName}`;
          setName(name);
        }
      }
    }

    void load();
    return () => {
      mounted = false;
      request.abort();
      window.clearTimeout(timeout);
      overrides.remove();
    };
  }, []);

  return name;
}
