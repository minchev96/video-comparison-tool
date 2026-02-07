import { fireEvent, render, screen } from '@testing-library/react'
import App from '../App.jsx'

const buildDataTransfer = (file) => ({
  dataTransfer: {
    files: [file],
    items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
  },
})

describe('App', () => {
  it('renders core layout', () => {
    render(<App />)

    expect(screen.getByText('Video Comparison Tool')).toBeInTheDocument()
    expect(screen.getByText('Left Source')).toBeInTheDocument()
    expect(screen.getByText('Right Source')).toBeInTheDocument()
    expect(screen.getByText('Comparison Controls')).toBeInTheDocument()
    expect(screen.getByText('Quality Checks')).toBeInTheDocument()
  })

  it('shows warning when both sources share the same name', () => {
    render(<App />)

    const leftDrop = screen.getByText('Left Source').closest('label')
    const rightDrop = screen.getByText('Right Source').closest('label')

    const file = new File(['video'], 'same.mp4', { type: 'video/mp4' })
    fireEvent.drop(leftDrop, buildDataTransfer(file))
    fireEvent.drop(rightDrop, buildDataTransfer(file))

    expect(
      screen.getByText('Warning: both sources share the same file name.'),
    ).toBeInTheDocument()
  })

  it('disables playback controls until both sources are loaded', () => {
    render(<App />)

    const playButton = screen.getByRole('button', { name: 'Play' })
    expect(playButton).toBeDisabled()
  })
})
