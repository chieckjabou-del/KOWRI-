import { useState, useEffect } from "react";

function getBreakpoint() {
  const w = typeof window !== "undefined" ? window.innerWidth : 768;
  return { isMobile: w < 768, isTablet: w >= 768 && w < 1024, isDesktop: w >= 1024 };
}

export function useResponsive() {
  const [bp, setBp] = useState(getBreakpoint);

  useEffect(() => {
    const handler = () => setBp(getBreakpoint());
    const mql = window.matchMedia("(max-width: 767px)");
    mql.addEventListener("change", handler);
    window.addEventListener("resize", handler);
    return () => {
      mql.removeEventListener("change", handler);
      window.removeEventListener("resize", handler);
    };
  }, []);

  return bp;
}
