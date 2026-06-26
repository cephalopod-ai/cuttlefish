import { useEffect, useState } from "react";

/** Returns true when document.visibilityState === "visible". Subscribes to
 *  the visibilitychange event so backgrounding/foregrounding the tab updates
 *  the value. SSR-safe (returns true when document is undefined). */
export function usePageVisibility(): boolean {
  const [visible, setVisible] = useState<boolean>(() => {
    if (typeof document === "undefined") return true;
    return document.visibilityState === "visible";
  });
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
