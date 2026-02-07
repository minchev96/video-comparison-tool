import { render, screen } from '@testing-library/react'
import CompareView from '../CompareView.jsx'

describe('CompareView', () => {
  it('shows placeholder when not loaded', () => {
    render(
      <CompareView
        compareWrapperRef={{ current: null }}
        compareAreaRef={{ current: null }}
        rightVideoRef={{ current: null }}
        leftVideoRef={{ current: null }}
        overlayRef={{ current: null }}
        rightSrc={null}
        leftSrc={null}
        leftGhost={false}
        mismatchEnabled={false}
        sliderPos={0.5}
        bothLoaded={false}
        onMouseMove={() => {}}
        onMouseDown={() => {}}
        onMouseUp={() => {}}
        onClick={() => {}}
        onContextMenu={() => {}}
        setVideoMeta={() => {}}
        handleTimeUpdate={() => {}}
        isPlaying={false}
        togglePlay={() => {}}
        onStepBack={() => {}}
        onStepForward={() => {}}
        currentTime={0}
        effectiveDuration={0}
        onSeekChange={() => {}}
        onSeekEnd={() => {}}
        formatTime={() => '00:00'}
        compareTransform={{ transform: 'scale(1)' }}
      />,
    )

    expect(
      screen.getByText('Drop two videos to start comparing.'),
    ).toBeInTheDocument()
  })
})
