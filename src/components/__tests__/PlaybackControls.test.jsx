import { render, screen } from '@testing-library/react'
import PlaybackControls from '../PlaybackControls.jsx'

describe('PlaybackControls', () => {
  it('disables controls when disabled prop is true', () => {
    render(
      <PlaybackControls
        isPlaying={false}
        onTogglePlay={() => {}}
        onStepBack={() => {}}
        onStepForward={() => {}}
        currentTime={0}
        effectiveDuration={10}
        onSeekChange={() => {}}
        onSeekEnd={() => {}}
        formatTime={() => '00:00'}
        disabled
      />,
    )

    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
  })
})
