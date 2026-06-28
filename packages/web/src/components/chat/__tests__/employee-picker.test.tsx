import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChatEmployeePicker } from '../chat-employee-picker'

// Mock EmployeeAvatar and surface the canonical icon props so we can assert
// that the picker forwards them.
vi.mock('@/components/ui/employee-avatar', () => ({
  EmployeeAvatar: ({ name, size, avatar, emoji }: { name: string; size?: number; avatar?: string; emoji?: string }) => (
    <span data-testid={`avatar-${name}`} data-avatar={avatar} data-emoji={emoji} style={{ width: size, height: size }}>
      {name.charAt(0).toUpperCase()}
    </span>
  ),
}))

const mockEmployees = [
  { name: 'lead-developer', displayName: 'Lead Developer', department: 'platform', rank: 'senior' as const },
  { name: 'content-lead', displayName: 'Content Lead', department: 'content', rank: 'manager' as const },
  { name: 'content-writer', displayName: 'Content Writer', department: 'content', rank: 'employee' as const },
  { name: 'demo-lead', displayName: 'Demo Lead', department: 'demo', rank: 'manager' as const },
  { name: 'demo-writer', displayName: 'Demo Writer', department: 'demo', rank: 'employee' as const },
  { name: 'acme-lead', displayName: 'Acme Lead', department: 'acme', rank: 'manager' as const },
  { name: 'labs-lead', displayName: 'Labs Lead', department: 'labs', rank: 'manager' as const },
  { name: 'studio-lead', displayName: 'Studio Lead', department: 'studio', rank: 'senior' as const },
  { name: 'reddit-scout', displayName: 'Reddit Scout', department: 'marketing', rank: 'employee' as const },
]

describe('ChatEmployeePicker', () => {
  let onChange: ReturnType<typeof vi.fn<(name: string | null) => void>>

  beforeEach(() => {
    onChange = vi.fn<(name: string | null) => void>()
  })

  // --- COO rendering ---

  it('renders COO at the top, highlighted as default', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    const cooRow = screen.getByRole('option', { name: /cuttlefish/i })
    expect(cooRow).toBeDefined()
    expect(cooRow.getAttribute('aria-selected')).toBe('true')
  })

  it('calls onSelect(null) when COO row is clicked', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee="lead-developer"
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    fireEvent.click(screen.getByRole('option', { name: /cuttlefish/i }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  // --- Department grouping ---

  it('groups employees by department with section headers', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    // Department headers should be present
    expect(screen.getByText('platform')).toBeDefined()
    expect(screen.getByText('content')).toBeDefined()
    expect(screen.getByText('demo')).toBeDefined()
    expect(screen.getByText('acme')).toBeDefined()
    expect(screen.getByText('marketing')).toBeDefined()
  })

  it('renders employees within their department groups', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    // All employees should be visible (no more/less toggle)
    expect(screen.getByText('Lead Developer')).toBeDefined()
    expect(screen.getByText('Content Lead')).toBeDefined()
    expect(screen.getByText('Content Writer')).toBeDefined()
    expect(screen.getByText('Demo Lead')).toBeDefined()
    expect(screen.getByText('Reddit Scout')).toBeDefined()
  })

  // --- Selection ---

  it('calls onSelect with employee name when row is clicked', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    fireEvent.click(screen.getByText('Lead Developer'))
    expect(onChange).toHaveBeenCalledWith('lead-developer')
  })

  it('shows selected state on the chosen employee', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee="lead-developer"
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    // COO should NOT be selected
    const cooRow = screen.getByRole('option', { name: /cuttlefish/i })
    expect(cooRow.getAttribute('aria-selected')).toBe('false')

    // Lead Developer should be selected
    const devRow = screen.getAllByRole('option').find(
      el => el.textContent?.includes('Lead Developer')
    )
    expect(devRow).toBeDefined()
    expect(devRow!.getAttribute('aria-selected')).toBe('true')
  })

  // --- Search reveal / collapse (picker, not composer) ---

  it('hides the search field by default — shows a magnifier button instead', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    // No prominent text input at rest (so it can't be mistaken for the composer)
    expect(screen.queryByPlaceholderText(/filter|search/i)).toBeNull()
    // A quiet magnifier action button is present
    expect(screen.getByRole('button', { name: /search employees/i })).toBeDefined()
  })

  it('reveals the search field when the magnifier button is clicked', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /search employees/i }))
    expect(screen.getByPlaceholderText(/filter|search/i)).toBeDefined()
  })

  it('auto-reveals the search field seeded with the typed character', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    const listbox = screen.getByRole('listbox')
    // Power-user type-to-filter: start typing on the clean list
    fireEvent.keyDown(listbox, { key: 'd' })
    const searchInput = screen.getByPlaceholderText(/filter|search/i) as HTMLInputElement
    expect(searchInput.value).toBe('d')
    // And it actually filters
    fireEvent.change(searchInput, { target: { value: 'developer' } })
    expect(screen.getByText('Lead Developer')).toBeDefined()
    expect(screen.queryByText('Content Lead')).toBeNull()
  })

  it('opens the search field on "/" without seeding a slash', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    fireEvent.keyDown(screen.getByRole('listbox'), { key: '/' })
    const searchInput = screen.getByPlaceholderText(/filter|search/i) as HTMLInputElement
    expect(searchInput.value).toBe('')
  })

  it('collapses the search field back to the clean list on Escape', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /search employees/i }))
    const searchInput = screen.getByPlaceholderText(/filter|search/i)
    fireEvent.change(searchInput, { target: { value: 'demo' } })
    fireEvent.keyDown(searchInput, { key: 'Escape' })

    // Field gone, magnifier back, full list restored
    expect(screen.queryByPlaceholderText(/filter|search/i)).toBeNull()
    expect(screen.getByRole('button', { name: /search employees/i })).toBeDefined()
    expect(screen.getByText('Lead Developer')).toBeDefined()
  })

  // --- Search / filter ---

  it('filters employees by name once the search is revealed', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /search employees/i }))
    const searchInput = screen.getByPlaceholderText(/filter|search/i)

    fireEvent.change(searchInput, { target: { value: 'developer' } })
    // Only Lead Developer should be visible
    expect(screen.getByText('Lead Developer')).toBeDefined()
    expect(screen.queryByText('Content Lead')).toBeNull()
    expect(screen.queryByText('Demo Lead')).toBeNull()
  })

  it('filters employees by department name', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /search employees/i }))
    const searchInput = screen.getByPlaceholderText(/filter|search/i)
    fireEvent.change(searchInput, { target: { value: 'content' } })

    // Both content employees should be visible
    expect(screen.getByText('Content Lead')).toBeDefined()
    expect(screen.getByText('Content Writer')).toBeDefined()
    // Others should not
    expect(screen.queryByText('Lead Developer')).toBeNull()
  })

  it('shows empty state when search matches nothing', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /search employees/i }))
    const searchInput = screen.getByPlaceholderText(/filter|search/i)
    fireEvent.change(searchInput, { target: { value: 'zzzzzzz' } })

    expect(screen.getByText(/no employees/i)).toBeDefined()
  })

  it('COO row is always visible regardless of search', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /search employees/i }))
    const searchInput = screen.getByPlaceholderText(/filter|search/i)
    fireEvent.change(searchInput, { target: { value: 'developer' } })

    // COO always visible
    expect(screen.getByRole('option', { name: /cuttlefish/i })).toBeDefined()
  })

  // --- Scrollable container ---

  it('renders a scrollable list container', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    const listbox = screen.getByRole('listbox')
    expect(listbox).toBeDefined()
    // Should have overflow-y-auto for scrolling
    expect(listbox.className).toContain('overflow-y-auto')
  })

  // --- Rank badges ---

  it('displays rank badges for managers and seniors', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    // Managers get "Mgr" badge, seniors get "Sr"
    const badges = screen.getAllByText(/^(Mgr|Sr)$/)
    expect(badges.length).toBeGreaterThan(0)
  })

  // --- Avatars ---

  it('renders avatars for employees', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees.slice(0, 3)}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    expect(screen.getByTestId('avatar-lead-developer')).toBeDefined()
    expect(screen.getByTestId('avatar-content-lead')).toBeDefined()
  })

  it('forwards the canonical avatar/emoji to each employee avatar', () => {
    render(
      <ChatEmployeePicker
        employees={[
          { name: 'finned', displayName: 'Finned', department: 'platform', rank: 'senior' as const, avatar: 'nautical:anchor' },
          { name: 'emojied', displayName: 'Emojied', department: 'platform', rank: 'senior' as const, emoji: '🦊' },
        ]}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    expect(screen.getByTestId('avatar-finned').getAttribute('data-avatar')).toBe('nautical:anchor')
    expect(screen.getByTestId('avatar-emojied').getAttribute('data-emoji')).toBe('🦊')
  })

  // --- Keyboard navigation ---

  it('navigates with arrow keys and selects with Enter', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    const listbox = screen.getByRole('listbox')

    // Arrow down once from COO → first employee
    fireEvent.keyDown(listbox, { key: 'ArrowDown' })
    fireEvent.keyDown(listbox, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('lead-developer')
  })

  it('keeps arrow/enter navigation working while the search field is open', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /search employees/i }))
    const searchInput = screen.getByPlaceholderText(/filter|search/i)

    // Arrow down once from COO → first employee, Enter selects — all from the field
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' })
    fireEvent.keyDown(searchInput, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('lead-developer')
  })

  it('ArrowUp from first employee goes to COO', () => {
    render(
      <ChatEmployeePicker
        employees={mockEmployees}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    const listbox = screen.getByRole('listbox')

    // Move down then up → back to COO
    fireEvent.keyDown(listbox, { key: 'ArrowDown' })
    fireEvent.keyDown(listbox, { key: 'ArrowUp' })
    fireEvent.keyDown(listbox, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(null)
  })

  // --- Empty state ---

  it('renders only COO when employees array is empty', () => {
    render(
      <ChatEmployeePicker
        employees={[]}
        selectedEmployee={null}
        onSelect={onChange}
        portalName="Cuttlefish"
      />
    )
    expect(screen.getByRole('option', { name: /cuttlefish/i })).toBeDefined()
    const allOptions = screen.getAllByRole('option')
    expect(allOptions).toHaveLength(1)
  })
})
