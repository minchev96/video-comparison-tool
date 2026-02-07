import { render, screen } from '@testing-library/react'
import TopBar from '../TopBar.jsx'

describe('TopBar', () => {
  it('shows ready badge and fps', () => {
    render(<TopBar bothLoaded fps={42} />)
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByText('FPS: 42')).toBeInTheDocument()
  })
})
