import { render, screen } from "@testing-library/react";
import CompareView from "../CompareView.jsx";

const baseProps = {
  compareWrapperRef: { current: null },
  compareAreaRef: { current: null },
  rightVideoRef: { current: null },
  leftVideoRef: { current: null },
  overlayRef: { current: null },
  rightSrc: null,
  leftSrc: null,
  sliderPos: 0.5,
  bothLoaded: false,
  onMouseMove: () => {},
  onMouseDown: () => {},
  onMouseUp: () => {},
  onClick: () => {},
  onContextMenu: () => {},
  setVideoMeta: () => {},
  handleTimeUpdate: () => {},
  isPlaying: false,
  togglePlay: () => {},
  onStepBack: () => {},
  onStepForward: () => {},
  currentTime: 0,
  effectiveDuration: 0,
  onSeekChange: () => {},
  onSeekEnd: () => {},
  formatTime: () => "00:00",
  compareTransform: { transform: "scale(1)" },
};

describe("CompareView", () => {
  it("shows placeholder when not loaded", () => {
    render(<CompareView {...baseProps} mismatchEnabled={false} />);

    expect(
      screen.getByText("Drop two videos to start comparing."),
    ).toBeInTheDocument();
  });

  it("hides divider line while mismatch overlay is active", () => {
    const { container } = render(
      <CompareView {...baseProps} mismatchEnabled />,
    );
    expect(container.querySelector(".slider-line")).not.toBeInTheDocument();
  });

  it("shows divider line while mismatch overlay is inactive", () => {
    const { container } = render(
      <CompareView {...baseProps} mismatchEnabled={false} />,
    );
    expect(container.querySelector(".slider-line")).toBeInTheDocument();
  });
});
