import { render, screen } from '@testing-library/react'
import QualityChecks from '../QualityChecks.jsx'

describe('QualityChecks', () => {
  it('renders metadata values', () => {
    render(
      <QualityChecks
        leftMeta={{ width: 1920, height: 1080, duration: 10 }}
        rightMeta={{ width: 1920, height: 1080, duration: 10 }}
        resolutionMismatch={false}
        durationMismatch={false}
        formatTime={(value) => `t:${value}`}
      />,
    )

    expect(screen.getByText('Resolution: 1920x1080 vs 1920x1080')).toBeInTheDocument()
    expect(screen.getByText('Duration: t:10 vs t:10')).toBeInTheDocument()
  })
})
