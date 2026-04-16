import { render, screen } from "@testing-library/react";
import ComparisonControls from "../ComparisonControls.jsx";

describe("ComparisonControls", () => {
  it("renders mismatch controls without ghost or mode options", () => {
    render(
      <ComparisonControls
        mismatchEnabled={false}
        setMismatchEnabled={() => {}}
        threshold={0.2}
        setThreshold={() => {}}
        zoom={1}
        setZoom={() => {}}
        bothLoaded={false}
      />,
    );

    expect(screen.getByText("Pixel mismatch overlay")).toBeInTheDocument();
    expect(
      screen.queryByText("Left source ghost (50% opacity)"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Mismatch mode")).not.toBeInTheDocument();
  });
});
