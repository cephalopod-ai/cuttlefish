import { describe, it, expect } from "vitest"
import { mainButtonMode } from "../main-button"

describe("mainButtonMode", () => {
  it("is 'mic' when idle with no typed text", () => {
    expect(mainButtonMode({ listening: false, hasText: false })).toBe("mic")
  })

  it("is 'send' when there is typed text", () => {
    expect(mainButtonMode({ listening: false, hasText: true })).toBe("send")
  })

  it("is 'stop' while recording, even with text in the box", () => {
    // Recording takes precedence — the button stops + sends the voice turn.
    expect(mainButtonMode({ listening: true, hasText: false })).toBe("stop")
    expect(mainButtonMode({ listening: true, hasText: true })).toBe("stop")
  })
})
