import { render, screen } from '@testing-library/react'
import ComparisonControls from '../ComparisonControls.jsx'

describe('ComparisonControls', () => {
  it('renders mismatch controls', () => {
    render(
      <ComparisonControls
        leftGhost={false}
        setLeftGhost={() => {}}
        mismatchEnabled={false}
        setMismatchEnabled={() => {}}
        threshold={0.2}
        setThreshold={() => {}}
        mismatchMode="binary"
        setMismatchMode={() => {}}
        useGpuDiff={false}
        setUseGpuDiff={() => {}}
        gpuSupported
        zoom={1}
        setZoom={() => {}}
        bothLoaded={false}
      />,
    )

    expect(screen.getByText('Pixel mismatch overlay')).toBeInTheDocument()
    expect(screen.getByText('Mismatch mode')).toBeInTheDocument()
  })
})
