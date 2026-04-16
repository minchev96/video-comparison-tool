import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App.jsx";

const buildDataTransfer = (file) => ({
  dataTransfer: {
    files: [file],
    items: [{ kind: "file", type: file.type, getAsFile: () => file }],
  },
});

describe("App", () => {
  const renderWithRoute = (route = "/") =>
    render(
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>,
    );

  const mockVideoMetadata = (
    video,
    width = 1920,
    height = 1080,
    duration = 10,
  ) => {
    Object.defineProperty(video, "videoWidth", {
      configurable: true,
      value: width,
    });
    Object.defineProperty(video, "videoHeight", {
      configurable: true,
      value: height,
    });
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: duration,
    });
  };

  it("renders core layout", () => {
    renderWithRoute("/");

    expect(screen.getByText("Video Comparison Tool")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Live Compare" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Left Source")).toBeInTheDocument();
    expect(screen.getByText("Right Source")).toBeInTheDocument();
    expect(screen.getByText("Comparison Controls")).toBeInTheDocument();
    expect(screen.getByText("Quality Checks")).toBeInTheDocument();
  });

  it("shows warning when both sources share the same name", () => {
    renderWithRoute("/");

    const leftDrop = screen.getByText("Left Source").closest("label");
    const rightDrop = screen.getByText("Right Source").closest("label");

    const file = new File(["video"], "same.mp4", { type: "video/mp4" });
    fireEvent.drop(leftDrop, buildDataTransfer(file));
    fireEvent.drop(rightDrop, buildDataTransfer(file));

    expect(
      screen.getByText("Warning: both sources share the same file name."),
    ).toBeInTheDocument();
  });

  it("disables playback controls until both sources are loaded", () => {
    renderWithRoute("/");

    const playButton = screen.getByRole("button", { name: "Play" });
    expect(playButton).toBeDisabled();
  });

  it("renders live page inputs when route is live", () => {
    renderWithRoute("/live");

    expect(screen.getByText("Live Website Comparison")).toBeInTheDocument();
    expect(screen.getByLabelText("URL 1")).toBeInTheDocument();
    expect(screen.getByLabelText("URL 2")).toBeInTheDocument();
  });

  it("starts comparison after second source is dropped", () => {
    const { container } = renderWithRoute("/");

    const leftDrop = screen.getByText("Left Source").closest("label");
    const rightDrop = screen.getByText("Right Source").closest("label");

    const leftFile = new File(["left-video"], "left.mp4", {
      type: "video/mp4",
    });
    const rightFile = new File(["right-video"], "right.mp4", {
      type: "video/mp4",
    });

    fireEvent.drop(leftDrop, buildDataTransfer(leftFile));

    const leftVideo = container.querySelector(".video-top");
    mockVideoMetadata(leftVideo);
    fireEvent.loadedMetadata(leftVideo);

    fireEvent.drop(rightDrop, buildDataTransfer(rightFile));

    const rightVideo = container.querySelector(".video-base");
    mockVideoMetadata(rightVideo);
    fireEvent.loadedMetadata(rightVideo);

    expect(
      screen.queryByText("Drop two videos to start comparing."),
    ).not.toBeInTheDocument();
  });
});
