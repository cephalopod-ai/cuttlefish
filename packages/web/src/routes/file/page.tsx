import { useSearchParams } from "react-router-dom";
import { FileView } from "@/components/chat/file-view";

/**
 * Standalone /file route. FileView (in chat/file-view.tsx) already picks a
 * dark/light Prism style from the active theme and re-renders on theme change
 * via the ThemeProvider context, so the syntax colors follow the two app
 * themes. What it does NOT do is blend the code block's surface into the Ledger
 * palette — Prism themes ship their own slate/white backgrounds that clash with
 * the warm charcoal / paper canvas.
 *
 * Rather than fork the shared component, we scope an override here: the wrapper
 * forces the highlighter's <pre>/<code> background + foreground to the
 * theme-driven CSS vars (--code-bg / --code-text). Because those vars are
 * redefined per `data-theme`, this is correct in BOTH themes with no JS theme
 * detection needed and it updates live when the theme flips. !important is
 * required to beat react-syntax-highlighter's inline styles.
 */
const codeSurfaceOverride = `
.cuttlefish-file-view pre[class*="language-"],
.cuttlefish-file-view pre[style] {
  background: var(--code-bg) !important;
  color: var(--code-text) !important;
  font-family: var(--font-code) !important;
}
.cuttlefish-file-view pre[class*="language-"] code,
.cuttlefish-file-view pre[style] > code {
  background: transparent !important;
  font-family: var(--font-code) !important;
}
`;

export default function FilePage() {
  const [sp] = useSearchParams();
  const path = sp.get("path") ?? "";
  return (
    <div className="cuttlefish-file-view">
      <style>{codeSurfaceOverride}</style>
      <FileView path={path} />
    </div>
  );
}
