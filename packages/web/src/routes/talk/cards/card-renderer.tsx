/**
 * Cuttlefish Talk — CardRenderer (Concept AURA).
 *
 * Renders a single typed "Lego-block" content card. Switches on the
 * discriminated `type` and draws each primitive richly against the glass shell.
 * All color comes from the Ledger theme tokens (see cards.css) so cards look
 * right in both light & dark themes. Icons via lucide-react.
 *
 * This component renders only the *contents* of a card; the glass shell, the
 * springy mount/unmount, stagger and presence tracking are owned by CardStack.
 */
import type { JSX } from "react"
import { useState } from "react"
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  Globe,
  X,
} from "lucide-react"
import type {
  AgentActivity,
  ApprovalCard,
  Card,
  ChoiceCard,
  ComparisonCard,
  DiffCard,
  ImageCard,
  ImageGridCard,
  KeyValueCard,
  LinkCard,
  ListCard,
  StatCard,
  StatusCard,
  TextCard,
} from "../types"
import "./cards.css"

/** Callback a card button fires to send a synthetic user message (action channel). */
type OnAction = (message: string) => void

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an image source. A "bare seed" (no slash, no protocol) becomes a
 * deterministic picsum placeholder; anything that already looks like a path or
 * URL is used as-is.
 */
function resolveImageSrc(src: string, w = 400, h = 240): string {
  const looksLikeUrlOrPath =
    /^(https?:)?\/\//.test(src) || src.startsWith("/") || src.includes("/")
  if (looksLikeUrlOrPath) return src
  return `https://picsum.photos/seed/${encodeURIComponent(src)}/${w}/${h}`
}

/**
 * Whether a card image src points at a remote host (an absolute http(s) or
 * protocol-relative URL). Card src values come from the orchestrator LLM, so an
 * injected model could turn an auto-loaded `<img>` into a zero-click exfil beacon
 * or intranet probe. Bare seeds (picsum placeholders) and relative/same-origin
 * paths are not remote and load normally. (AR-11)
 */
function isRemoteImageUrl(src: string): boolean {
  return /^(https?:)?\/\//i.test(src.trim())
}

/**
 * A card image that only fetches a *remote* URL after an explicit click, so
 * viewing a card never triggers an automatic cross-origin request. Same-origin /
 * relative / placeholder images render immediately.
 */
function CardImage({
  src,
  alt,
  w,
  h,
  className,
}: {
  src: string
  alt: string
  w: number
  h: number
  className?: string
}): JSX.Element {
  const remote = isRemoteImageUrl(src)
  const [loaded, setLoaded] = useState(!remote)
  if (!loaded) {
    return (
      <button
        type="button"
        className={className}
        onClick={() => setLoaded(true)}
        title={`Load image from ${hostnameOf(src)}`}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          width: "100%",
          minHeight: Math.min(Math.max(h, 96), 160),
          border: "1px dashed color-mix(in srgb, currentColor 30%, transparent)",
          borderRadius: 8,
          background: "transparent",
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
          padding: 12,
        }}
      >
        <Globe size={16} aria-hidden />
        <span>Load image from {hostnameOf(src)}</span>
      </button>
    )
  }
  return (
    <img
      className={className}
      src={resolveImageSrc(src, w, h)}
      alt={alt}
      loading="lazy"
      draggable={false}
    />
  )
}

/** Best-effort hostname for a link's source line. */
function hostnameOf(url: string, fallback?: string): string {
  if (fallback) return fallback
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

// ---------------------------------------------------------------------------
// Card header (shared eyebrow + badge)
// ---------------------------------------------------------------------------
function CardHead({ title, badge }: { title?: string; badge?: string }) {
  if (!title && !badge) return null
  return (
    <div className="jt-card__head">
      {title ? <span className="jt-card__title">{title}</span> : <span />}
      {badge ? <b className="jt-card__badge">{badge}</b> : null}
    </div>
  )
}

function Chips({ chips }: { chips?: string[] }) {
  if (!chips || chips.length === 0) return null
  return (
    <div className="jt-chips">
      {chips.map((c, i) => (
        <span className="jt-chip" key={`${c}-${i}`}>
          {c}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-type primitives
// ---------------------------------------------------------------------------

function TextBody({ card }: { card: TextCard }) {
  return (
    <div className="jt-card__body">
      {card.tldr ? <div className="jt-tldr">{card.tldr}</div> : null}
      <p className="jt-prose">{card.body}</p>
    </div>
  )
}

function StatBody({ card }: { card: StatCard }) {
  const { delta } = card
  const dirClass = delta ? `jt-delta--${delta.dir}` : ""
  const DeltaIcon =
    delta?.dir === "up"
      ? ArrowUp
      : delta?.dir === "down"
        ? ArrowDown
        : ArrowRight
  return (
    <div className="jt-card__body">
      <div className="jt-stat__value">{card.value}</div>
      <div className="jt-stat__label">{card.label}</div>
      {delta ? (
        <div className={`jt-stat__delta ${dirClass}`}>
          <DeltaIcon size={15} strokeWidth={2.5} aria-hidden />
          <span>{delta.value}</span>
        </div>
      ) : null}
    </div>
  )
}

function ListBody({ card }: { card: ListCard }) {
  const ordered = card.ordered === true
  return (
    <ul className="jt-list jt-card__body" role="list">
      {card.items.map((item, i) => (
        <li className="jt-list__item" key={`${item.text}-${i}`}>
          <span className="jt-list__marker">
            {item.done ? (
              <Check
                className="jt-list__check"
                size={15}
                strokeWidth={3}
                aria-hidden
              />
            ) : ordered ? (
              <span className="jt-list__num">{i + 1}.</span>
            ) : (
              <span className="jt-list__dot" aria-hidden />
            )}
          </span>
          <span className={item.done ? "jt-list__text--done" : undefined}>
            {item.text}
          </span>
        </li>
      ))}
    </ul>
  )
}

function ImageBody({ card }: { card: ImageCard }) {
  return (
    <figure className="jt-card__body" style={{ margin: 0 }}>
      <CardImage className="jt-img" src={card.src} alt={card.alt ?? ""} w={400} h={240} />
      {card.caption ? (
        <figcaption className="jt-img__caption">{card.caption}</figcaption>
      ) : null}
    </figure>
  )
}

function ImageGridBody({ card }: { card: ImageGridCard }) {
  return (
    <div className="jt-grid jt-card__body">
      {card.images.map((img, i) => (
        <CardImage
          className="jt-img"
          key={`${img.src}-${i}`}
          src={img.src}
          alt={img.alt ?? ""}
          w={300}
          h={220}
        />
      ))}
    </div>
  )
}

const STATE_WORD: Record<StatusCard["state"], string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  error: "Error",
}

function StatusBody({ card }: { card: StatusCard }) {
  const pct = Math.round(Math.max(0, Math.min(1, card.progress)) * 100)
  return (
    <div className="jt-card__body">
      <div className="jt-status__row">
        <span className="jt-status__label">{card.label}</span>
        <span className={`jt-status__state jt-state--${card.state}`}>
          <span className="jt-dot" aria-hidden />
          {STATE_WORD[card.state]}
        </span>
      </div>
      <div
        className="jt-bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span
          className={
            card.state === "error" ? "jt-bar__fill jt-bar__fill--error" : "jt-bar__fill"
          }
          /* width starts at 0 (CSS) and transitions to target on mount */
          ref={(el) => {
            if (el) requestAnimationFrame(() => (el.style.width = `${pct}%`))
          }}
        />
      </div>
      <Chips chips={card.chips} />
    </div>
  )
}

function AgentRow({ agent }: { agent: AgentActivity }) {
  const pct =
    agent.progress != null
      ? Math.round(Math.max(0, Math.min(1, agent.progress)) * 100)
      : null
  return (
    <div className={`jt-agent jt-agent--${agent.status}`}>
      <span className="jt-agent__dot" aria-hidden />
      <div className="jt-agent__body">
        <div className="jt-agent__name">
          {agent.name}
          <span className="jt-agent__role"> · {agent.role}</span>
        </div>
        {agent.detail ? (
          <div className="jt-agent__detail">{agent.detail}</div>
        ) : null}
        {pct != null ? (
          <div className="jt-agent__bar">
            <i
              ref={(el) => {
                if (el) requestAnimationFrame(() => (el.style.width = `${pct}%`))
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

function AgentActivityBody({ agents }: { agents: AgentActivity[] }) {
  return (
    <div className="jt-agents jt-card__body">
      {agents.map((a) => (
        <AgentRow key={a.id} agent={a} />
      ))}
    </div>
  )
}

function LinkBody({ card }: { card: LinkCard }) {
  // Rendered as the whole card (anchor) so the hover-lift applies to the shell;
  // CardStack detects link cards and renders this as the card element itself.
  return (
    <>
      <span className="jt-link__icon" aria-hidden>
        <Globe size={18} strokeWidth={2} />
      </span>
      <span className="jt-link__body">
        <span className="jt-link__label">{card.label}</span>
        <span className="jt-link__source">{hostnameOf(card.url, card.source)}</span>
      </span>
    </>
  )
}

// ---------------------------------------------------------------------------
// Decision-support primitives (INTERACTIVE — buttons fire onAction)
// ---------------------------------------------------------------------------

function ChoiceBody({ card, onAction }: { card: ChoiceCard; onAction?: OnAction }) {
  return (
    <div className="jt-card__body">
      {card.prompt ? <p className="jt-choice__prompt">{card.prompt}</p> : null}
      <div className="jt-choice">
        {card.options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className="jt-choice__opt jt-action"
            onClick={() =>
              onAction?.(`[card-action card=${card.id} action=choose option=${opt.id}] ${opt.label}`)
            }
          >
            <span className="jt-choice__head">
              <span className="jt-choice__label">{opt.label}</span>
              {opt.badge ? <span className="jt-choice__badge">{opt.badge}</span> : null}
            </span>
            {opt.detail ? <span className="jt-choice__detail">{opt.detail}</span> : null}
            {opt.meta && opt.meta.length > 0 ? (
              <span className="jt-choice__meta">
                {opt.meta.map((m, i) => (
                  <span className="jt-choice__metaItem" key={`${m.k}-${i}`}>
                    <b>{m.k}</b> {m.v}
                  </span>
                ))}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}

function ComparisonBody({ card }: { card: ComparisonCard }) {
  return (
    <div className="jt-card__body jt-cmp__wrap">
      <table className="jt-cmp">
        <thead>
          <tr>
            <th />
            {card.columns.map((c, i) => (
              <th key={`${c}-${i}`}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {card.rows.map((row, ri) => (
            <tr key={`${row.label}-${ri}`}>
              <th scope="row">{row.label}</th>
              {row.cells.map((cell, ci) => (
                <td key={ci} className={row.highlight === ci ? "jt-cmp__hl" : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ApprovalBody({ card, onAction }: { card: ApprovalCard; onAction?: OnAction }) {
  const confirm = card.confirmLabel ?? "Approve"
  const reject = card.rejectLabel ?? "Reject"
  return (
    <div className={`jt-card__body jt-approval${card.danger ? " jt-approval--danger" : ""}`}>
      <p className="jt-approval__summary">
        {card.danger ? (
          <AlertTriangle className="jt-approval__warn" size={16} strokeWidth={2.5} aria-hidden />
        ) : null}
        {card.summary}
      </p>
      {card.details && card.details.length > 0 ? (
        <dl className="jt-kv">
          {card.details.map((d, i) => (
            <div className="jt-kv__row" key={`${d.k}-${i}`}>
              <dt className="jt-kv__k">{d.k}</dt>
              <dd className="jt-kv__v">{d.v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="jt-approval__actions">
        <button
          type="button"
          className="jt-approval__btn jt-approval__btn--reject jt-action"
          onClick={() => onAction?.(`[card-action card=${card.id} action=reject] ${reject}`)}
        >
          <X size={15} strokeWidth={2.5} aria-hidden /> {reject}
        </button>
        <button
          type="button"
          className={`jt-approval__btn jt-approval__btn--confirm jt-action${card.danger ? " jt-approval__btn--danger" : ""}`}
          onClick={() => onAction?.(`[card-action card=${card.id} action=approve] ${confirm}`)}
        >
          <Check size={15} strokeWidth={2.5} aria-hidden /> {confirm}
        </button>
      </div>
    </div>
  )
}

function KeyValueBody({ card }: { card: KeyValueCard }) {
  return (
    <dl className="jt-kv jt-card__body">
      {card.rows.map((row, i) => (
        <div className="jt-kv__row" key={`${row.k}-${i}`}>
          <dt className="jt-kv__k">{row.k}</dt>
          <dd className={`jt-kv__v jt-kv__v--${row.tone ?? "neutral"}`}>{row.v}</dd>
        </div>
      ))}
    </dl>
  )
}

function DiffBody({ card }: { card: DiffCard }) {
  return (
    <div className="jt-card__body jt-diff">
      {card.hunks.map((hunk, i) => (
        <div className="jt-diff__hunk" key={i}>
          {hunk.label ? <div className="jt-diff__label">{hunk.label}</div> : null}
          {hunk.before !== undefined ? (
            <pre className="jt-diff__line jt-diff__line--before">{hunk.before}</pre>
          ) : null}
          {hunk.after !== undefined ? (
            <pre className="jt-diff__line jt-diff__line--after">{hunk.after}</pre>
          ) : null}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

/**
 * Render the inner content of a single card. CardStack wraps this in the glass
 * shell (and, for links, supplies the anchor element). For links we expose the
 * icon+label fragment via the same switch so the renderer remains the single
 * source of per-type markup.
 */
export function CardRenderer({
  card,
  onAction,
}: {
  card: Card
  onAction?: OnAction
}): JSX.Element {
  switch (card.type) {
    case "text":
      return (
        <>
          <CardHead title={card.title} badge={card.badge} />
          <TextBody card={card} />
        </>
      )
    case "stat":
      return (
        <>
          <CardHead title={card.title} badge={card.badge} />
          <StatBody card={card} />
        </>
      )
    case "list":
      return (
        <>
          <CardHead title={card.title} badge={card.badge} />
          <ListBody card={card} />
        </>
      )
    case "image":
      return (
        <>
          <CardHead title={card.title} badge={card.badge} />
          <ImageBody card={card} />
        </>
      )
    case "image-grid":
      return (
        <>
          <CardHead title={card.title} badge={card.badge} />
          <ImageGridBody card={card} />
        </>
      )
    case "status":
      return (
        <>
          <CardHead title={card.title} badge={card.badge} />
          <StatusBody card={card} />
        </>
      )
    case "agent-activity":
      return (
        <>
          <CardHead title={card.title} badge={card.badge} />
          <AgentActivityBody agents={card.agents} />
        </>
      )
    case "link":
      // Link cards have no eyebrow header by default — the whole card is the
      // tappable target. CardStack renders this fragment inside an <a>.
      return <LinkBody card={card} />
    case "choice":
      return (
        <>
          <CardHead title={card.title} badge={card.badge} />
          <ChoiceBody card={card} onAction={onAction} />
        </>
      )
    case "comparison":
      return (
        <>
          <CardHead title={card.title} badge={card.badge} />
          <ComparisonBody card={card} />
        </>
      )
    case "approval":
      return (
        <>
          <CardHead title={card.title} badge={card.badge} />
          <ApprovalBody card={card} onAction={onAction} />
        </>
      )
    case "keyvalue":
      return (
        <>
          <CardHead title={card.title} badge={card.badge} />
          <KeyValueBody card={card} />
        </>
      )
    case "diff":
      return (
        <>
          <CardHead title={card.title} badge={card.badge} />
          <DiffBody card={card} />
        </>
      )
    default: {
      // Exhaustiveness guard — if a new card type is added to the union this
      // line fails to compile until handled here.
      const _exhaustive: never = card
      return <>{_exhaustive}</>
    }
  }
}
