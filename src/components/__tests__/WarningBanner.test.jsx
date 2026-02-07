import { render, screen } from '@testing-library/react'
import WarningBanner from '../WarningBanner.jsx'

describe('WarningBanner', () => {
  it('renders provided message', () => {
    render(<WarningBanner message="Test warning" />)
    expect(screen.getByText('Test warning')).toBeInTheDocument()
  })
})
