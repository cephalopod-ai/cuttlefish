import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { PairingScreen } from "./pairing-screen"

describe("PairingScreen", () => {
  it("submits the entered remote access code", () => {
    const onPair = vi.fn()
    render(
      <PairingScreen
        authState={{ authRequired: true, authenticated: false, canBootstrapLocal: false, networkExposed: true }}
        pairing={false}
        onPair={onPair}
      />,
    )

    fireEvent.change(screen.getByLabelText(/remote access code/i), {
      target: { value: "ABCD-EFGH-JKLM" },
    })
    fireEvent.click(screen.getByRole("button", { name: /pair browser/i }))

    expect(onPair).toHaveBeenCalledWith("ABCD-EFGH-JKLM", "code")
    expect(screen.getByText(/private network/i)).toBeTruthy()
  })

  it("separates CLI and web UI pairing flows into explicit choices", () => {
    render(
      <PairingScreen
        authState={{ authRequired: true, authenticated: false, canBootstrapLocal: false, networkExposed: true }}
        pairing={false}
        onPair={() => {}}
      />,
    )

    expect(screen.getByRole("button", { name: /pair with cuttlefish cli/i })).toBeTruthy()
    expect(screen.getByRole("button", { name: /pair from web settings/i })).toBeTruthy()
    expect(screen.getByText(/run this on the mac where cuttlefish is running/i)).toBeTruthy()
    expect(screen.getByText(/cuttlefish pair/i)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /pair from web settings/i }))

    expect(screen.getByText(/open the already-paired local dashboard/i)).toBeTruthy()
    expect(screen.getByText(/Settings.*Pairing.*Create pairing code/i)).toBeTruthy()
    expect(screen.getByText(/Enter the code below/i)).toBeTruthy()
  })

  it("toggles the open pairing flow closed when its header is clicked again", () => {
    render(
      <PairingScreen
        authState={{ authRequired: true, authenticated: false, canBootstrapLocal: false, networkExposed: true }}
        pairing={false}
        onPair={() => {}}
      />,
    )

    const cliHeader = screen.getByRole("button", { name: /pair with cuttlefish cli/i })
    expect(cliHeader.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText(/run this on the mac where cuttlefish is running/i)).toBeTruthy()

    fireEvent.click(cliHeader)

    expect(cliHeader.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText(/run this on the mac where cuttlefish is running/i)).toBeNull()
  })

  it("keeps fallback setup-token pairing explicit and ephemeral", () => {
    const onPair = vi.fn()
    render(
      <PairingScreen
        authState={{ authRequired: true, authenticated: false, canBootstrapLocal: false, networkExposed: true }}
        pairing={false}
        onPair={onPair}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /use setup token/i }))
    const input = screen.getByLabelText(/setup token/i) as HTMLInputElement
    expect(input.type).toBe("password")

    fireEvent.change(input, { target: { value: "gateway-token" } })
    fireEvent.click(screen.getByRole("button", { name: /pair browser/i }))

    expect(onPair).toHaveBeenCalledWith("gateway-token", "token")
    expect(screen.getByRole("button", { name: /use remote access code/i })).toBeTruthy()
  })

  it("shows error and disabled loading states without exposing tokens", () => {
    render(
      <PairingScreen
        authState={{ authRequired: true, authenticated: false, canBootstrapLocal: false, networkExposed: true }}
        pairing
        error="Invalid or expired pairing code"
        onPair={() => {}}
      />,
    )

    expect(screen.getByRole("alert").textContent).toMatch(/Create a new remote access code/i)
    expect(screen.getByLabelText(/remote access code/i).getAttribute("aria-invalid")).toBe("true")
    expect((screen.getByRole("button", { name: /pairing/i }) as HTMLButtonElement).disabled).toBe(true)
    expect(document.body.textContent).not.toContain("Bearer")
  })

  it("uses setup-token-specific recovery copy and keeps the page scrollable", () => {
    render(
      <PairingScreen
        authState={{ authRequired: true, authenticated: false, canBootstrapLocal: false, networkExposed: true }}
        pairing={false}
        error="Invalid or expired pairing code"
        onPair={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /use setup token/i }))

    expect(screen.getByRole("alert").textContent).toMatch(/Setup token was not accepted/i)
    expect(screen.getByRole("main").className).toContain("overflow-y-auto")
    expect(screen.getByRole("button", { name: /use remote access code/i }).className).toContain("min-h-10")
  })
})
