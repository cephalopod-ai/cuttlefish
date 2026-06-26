import { useEffect, useMemo, useState } from 'react'

/* ============================================================
   FINAL DIRECTION — "Ledger Dock".  /redesign?c=dark|light
   Employee rail · per-agent chat list · focused conversation ·
   command-bar input · ⌘K switcher.  Two themes, one structure.
   &palette=1 shows the ⌘K switcher · &bare=1 hides the top toggle.
   ============================================================ */

type Theme = 'dark' | 'light'
const THEMES: { id: Theme; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
]

const E = { jimbo: '\u{1F3A9}', dev: '\u{1F9D1}‍\u{1F4BB}', projA: '⚖️', projB: '\u{1F4E6}', cos: '\u{1F4CB}', scout: '\u{1F47D}' }
const SAMPLE = {
  user1: 'What’s the status on the Project B billing fix?',
  reply: 'The AVS / billing-address fix shipped to all Project B Checkout Sessions — `billing_address_collection: "required"`. Conversion held flat through the first 48 hours, so no regression. I’ve queued the 30-day review for June 17. Want me to wire a PostHog funnel alert in the meantime?',
}
const EMPLOYEES = [
  { id: 'jimbo', emoji: E.jimbo, name: 'Jimbo', state: 'idle', unread: 0 },
  { id: 'lead-developer', emoji: E.dev, name: 'Lead Developer', state: 'working', unread: 0 },
  { id: 'projB', emoji: E.projB, name: 'Project B Support', state: 'working', unread: 2 },
  { id: 'projA', emoji: E.projA, name: 'Project A Lead', state: 'idle', unread: 0 },
  { id: 'cos', emoji: E.cos, name: 'Chief of Staff', state: 'idle', unread: 1 },
  { id: 'scout', emoji: E.scout, name: 'Growth Scout', state: 'idle', unread: 0 },
]
const DEV_CHATS = [
  { title: 'Project B billing fix', snippet: 'queued the 30-day review…', state: 'working' },
  { title: 'Gateway WS reconnect', snippet: 'patched the boot-guard', state: 'idle' },
  { title: 'Redesign showcase', snippet: 'ledger dock, light + dark', state: 'idle' },
]
function mdLite(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

function DockShell({ theme, palette }: { theme: Theme; palette: boolean }) {
  return (
    <div className="dk2" data-theme={theme}>
      <aside className="dk-rail">
        <div className="dk-mark">◧</div>
        {EMPLOYEES.map((a, i) => (
          <button key={a.id} className={`dk-tile ${i === 1 ? 'is-active' : ''} ${a.state === 'working' ? 'is-working' : ''}`} title={a.name}>
            {a.emoji}{a.unread > 0 && <span className="dk-badge">{a.unread}</span>}
          </button>
        ))}
        <div className="dk-grow" />
        <button className="dk-tile dk-add">+</button>
      </aside>

      <aside className="dk-chats">
        <div className="dk-chats-head"><span className="dk-emp">{E.dev} Lead Developer</span><span className="dk-emp-state">working</span></div>
        <button className="dk-search">Search agents & chats <kbd>⌘K</kbd></button>
        {DEV_CHATS.map((c, i) => (
          <div key={c.title} className={`dk-chat ${i === 0 ? 'is-active' : ''}`}>
            <div className="dk-chat-t">{c.title}{c.state === 'working' && <span className="dk-run" />}</div>
            <div className="dk-chat-s">{c.snippet}</div>
          </div>
        ))}
      </aside>

      <main className="dk-main">
        <div className="dk-thread">
          <div className="dk-turn dk-turn-you">
            <div className="dk-av dk-av-you">H</div>
            <div className="dk-msg"><p>{SAMPLE.user1}</p></div>
          </div>
          <div className="dk-turn">
            <div className="dk-av">{E.dev}</div>
            <div className="dk-msg">
              <div className="dk-byline">LEAD-DEVELOPER</div>
              <p dangerouslySetInnerHTML={{ __html: mdLite(SAMPLE.reply) }} />
              <div className="dk-tool">▪ ran 4 tools · 1.8s</div>
            </div>
          </div>
        </div>
        <div className="dk-bar">
          <span className="dk-bar-sigil">›</span>
          <span className="dk-bar-in"><span>Draft the PostHog funnel alert</span><span className="dk-caret" /></span>
          <span className="dk-bar-keys">⏎ send&nbsp;&nbsp;⌥⏎ newline&nbsp;&nbsp;/ cmd&nbsp;&nbsp;@ agent</span>
        </div>
      </main>

      {palette && (
        <div className="dk-overlay">
          <div className="dk-palette">
            <div className="dk-pal-input"><span>proj</span><span className="dk-caret" /></div>
            <div className="dk-pal-group">EMPLOYEES</div>
            <div className="dk-pal-row is-sel">{E.projB} <b>Project B Support</b><span className="dk-pal-mut">2 unread · working</span><kbd>↵</kbd></div>
            <div className="dk-pal-group">CHATS</div>
            <div className="dk-pal-row">{E.dev} Project B billing fix <span className="dk-pal-mut">Lead Developer · working</span></div>
            <div className="dk-pal-row">{E.projB} Refund — Sample Customer <span className="dk-pal-mut">Project B · awaiting ✅</span></div>
            <div className="dk-pal-foot"><span>↑↓ navigate</span><span>↵ open</span><span>⌘↵ open in split</span><span>esc</span></div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function RedesignPage() {
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
  const initial = (params.get('c') as Theme) || 'dark'
  const palette = params.get('palette') === '1'
  const hideSwitcher = params.get('bare') === '1'
  const [theme, setTheme] = useState<Theme>(THEMES.some((t) => t.id === initial) ? initial : 'dark')

  useEffect(() => {
    document.documentElement.setAttribute('data-redesign', theme)
    return () => document.documentElement.removeAttribute('data-redesign')
  }, [theme])

  const body = useMemo(() => <DockShell theme={theme} palette={palette} />, [theme, palette])

  return (
    <div className="rd-shell">
      <style>{CSS}</style>
      {!hideSwitcher && (
        <div className="rd-switch">
          {THEMES.map((t) => (
            <button key={t.id} className={theme === t.id ? 'is-on' : ''} onClick={() => setTheme(t.id)}>{t.label}</button>
          ))}
        </div>
      )}
      {body}
    </div>
  )
}

const CSS = String.raw`
.rd-shell{position:fixed;inset:0;overflow:hidden}
.rd-switch{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:80;display:flex;gap:2px;padding:3px;border-radius:999px;background:rgba(20,20,24,.55);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.12)}
.rd-switch button{font:500 12px/1 ui-sans-serif,system-ui;letter-spacing:.02em;color:rgba(255,255,255,.62);background:transparent;border:0;padding:7px 16px;border-radius:999px;cursor:pointer;transition:.18s}
.rd-switch button.is-on{background:#fff;color:#111}

/* ---------- THEME TOKENS ---------- */
.dk2[data-theme="dark"]{
  --ink:#E8E4D8;--soft:#A8A290;--faint:#6E6957;--line:rgba(255,255,255,.09);
  --surface:rgba(255,255,255,.045);--surface2:rgba(255,255,255,.07);
  --accent:#E0A33C;--accentText:#14130F;--ok:#7DBE6A;
  --font:"Hanken Grotesk",system-ui,sans-serif;--mono:"IBM Plex Mono",monospace;
  --railBg:rgba(0,0,0,.25);--code:rgba(224,163,60,.14);--ovl:rgba(0,0,0,.5);
  background:#14130F}
.dk2[data-theme="light"]{
  --ink:#211E16;--soft:#6B6655;--faint:#9A937F;--line:#DED8C7;
  --surface:#FBF9F2;--surface2:#ECE8DC;
  --accent:#B07A1A;--accentText:#FBF9F2;--ok:#5C7A4A;
  --font:"Hanken Grotesk",system-ui,sans-serif;--mono:"IBM Plex Mono",monospace;
  --railBg:#EDE9DD;--code:rgba(176,122,26,.16);--ovl:rgba(40,34,20,.28);
  background:#F4F1E8}

/* ---------- shared DOCK layout ---------- */
.dk2{position:absolute;inset:0;display:flex;color:var(--ink);font-family:var(--font)}
.dk2 code{font-family:var(--mono);font-size:.82em;padding:.08em .35em;border-radius:5px;background:var(--code)}
.dk-rail{width:64px;flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px 0;border-right:1px solid var(--line);background:var(--railBg)}
.dk-mark{color:var(--accent);font-size:18px;margin-bottom:6px}
.dk-tile{position:relative;width:40px;height:40px;border-radius:8px;display:grid;place-items:center;font-size:18px;background:var(--surface);border:1px solid var(--line);cursor:pointer;transition:.16s;color:var(--ink)}
.dk-tile:hover{transform:translateY(-1px)}
.dk-tile.is-active{border-color:var(--accent);box-shadow:0 0 0 1.5px var(--accent)}
.dk-tile.is-working::after{content:"";position:absolute;top:-2px;right:-2px;width:9px;height:9px;border-radius:50%;background:var(--accent);border:2px solid var(--railBg)}
.dk-badge{position:absolute;bottom:-4px;right:-4px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--accent);color:var(--accentText);font-size:10px;font-weight:600;display:grid;place-items:center;font-family:var(--mono)}
.dk-grow{flex:1}
.dk-add{font-size:20px;color:var(--faint);border-style:dashed;background:transparent}
.dk-chats{width:248px;flex:0 0 auto;border-right:1px solid var(--line);padding:16px 12px;display:flex;flex-direction:column;gap:6px}
.dk-chats-head{display:flex;align-items:baseline;justify-content:space-between;padding:2px 6px 6px}
.dk-emp{font-size:14px;font-weight:600}
.dk-emp-state{font-family:var(--mono);font-size:11px;color:var(--accent)}
.dk-search{display:flex;align-items:center;justify-content:space-between;width:100%;padding:9px 12px;border-radius:10px;background:var(--surface2);border:1px solid var(--line);color:var(--faint);font:inherit;font-size:13px;cursor:pointer;margin-bottom:6px}
.dk-search kbd{font-family:var(--mono);font-size:11px;background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:1px 5px;color:var(--soft)}
.dk-chat{padding:10px 12px;border-radius:10px;cursor:pointer}
.dk-chat:hover{background:var(--surface2)}
.dk-chat.is-active{background:var(--surface);border:1px solid var(--line)}
.dk-chat-t{font-size:13.5px;font-weight:550;display:flex;align-items:center;gap:7px}
.dk-run{width:7px;height:7px;border-radius:50%;background:var(--accent)}
.dk-chat-s{font-size:12px;color:var(--soft);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dk-main{flex:1;position:relative;min-width:0;display:flex;flex-direction:column}
.dk-thread{flex:1;overflow:auto;width:100%;padding:40px 40px 90px}
.dk-turn{display:flex;gap:16px;margin-bottom:26px}
.dk-av{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;font-size:16px;background:var(--surface);border:1px solid var(--line);flex:0 0 auto}
.dk-av-you{background:var(--accent);color:var(--accentText);font-weight:600;font-size:14px;border-color:transparent}
.dk-msg{flex:1}
.dk-turn-you .dk-msg p{color:var(--soft)}
.dk-byline{font-family:var(--mono);font-size:11px;letter-spacing:.08em;color:var(--accent);margin-bottom:6px}
.dk-msg p{font-size:15.5px;line-height:1.66;color:var(--ink)}
.dk-tool{margin-top:12px;font-family:var(--mono);font-size:11.5px;color:var(--faint)}

/* command-bar input */
.dk-caret{display:inline-block;width:8px;height:17px;background:var(--accent);margin-left:2px;vertical-align:-2px;animation:dkBlink 1.1s steps(1) infinite}
@keyframes dkBlink{50%{opacity:0}}
.dk-bar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:12px;height:54px;padding:0 24px;border-top:1px solid var(--line);background:var(--surface2);font-family:var(--mono)}
.dk-bar-sigil{color:var(--accent);font-size:17px;font-weight:600}
.dk-bar-in{flex:1;display:flex;align-items:center;font-size:14.5px;color:var(--ink)}
.dk-bar-keys{font-size:11px;color:var(--faint);white-space:nowrap}

/* ⌘K palette */
.dk-overlay{position:absolute;inset:0;background:var(--ovl);backdrop-filter:blur(2px);display:flex;justify-content:center;padding-top:13vh;z-index:20}
.dk-palette{width:min(560px,90%);height:max-content;background:var(--surface2);border:1px solid var(--line);border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.4);overflow:hidden;font-family:var(--font)}
.dk-pal-input{display:flex;align-items:center;padding:18px 20px;font-size:18px;border-bottom:1px solid var(--line);color:var(--ink)}
.dk-pal-group{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;color:var(--faint);padding:12px 20px 4px}
.dk-pal-row{display:flex;align-items:center;gap:10px;padding:9px 20px;font-size:14px;cursor:pointer;color:var(--ink)}
.dk-pal-row .dk-pal-mut{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--faint)}
.dk-pal-row kbd{font-family:var(--mono);font-size:11px;background:var(--surface);border-radius:4px;padding:1px 5px;margin-left:10px}
.dk-pal-row.is-sel{background:var(--surface);box-shadow:inset 2px 0 0 var(--accent)}
.dk-pal-foot{display:flex;gap:16px;padding:11px 20px;border-top:1px solid var(--line);font-family:var(--mono);font-size:11px;color:var(--faint)}
`
