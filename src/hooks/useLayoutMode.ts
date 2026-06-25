import { useEffect, useState } from "react";

const LAYOUT_MODE_STORAGE_KEY = "denmark.layoutMode";
const MOBILE_LAYOUT_QUERY = "(max-width: 900px)";

export type LayoutMode = "auto" | "desktop" | "mobile";

function getSavedLayoutMode(): LayoutMode {
  if (typeof window === "undefined") return "auto";

  const saved = window.localStorage.getItem(LAYOUT_MODE_STORAGE_KEY);
  return saved === "desktop" || saved === "mobile" || saved === "auto"
    ? saved
    : "auto";
}

function getIsCompactViewport() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
}

export function useLayoutMode() {
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(getSavedLayoutMode);
  const [isCompactViewport, setIsCompactViewport] = useState(getIsCompactViewport);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const mediaQuery = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsCompactViewport(event.matches);
    };

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LAYOUT_MODE_STORAGE_KEY, layoutMode);
  }, [layoutMode]);

  const effectiveLayoutMode =
    layoutMode === "auto" ? (isCompactViewport ? "mobile" : "desktop") : layoutMode;

  return {
    effectiveLayoutMode,
    layoutMode,
    setLayoutMode,
  };
}
