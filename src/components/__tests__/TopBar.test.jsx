import { render, screen } from "@testing-library/react";
import TopBar from "../TopBar.jsx";

describe("TopBar", () => {
  it("shows navigation", () => {
    render(
      <TopBar sourceMode="file" onGoFiles={() => {}} onGoLive={() => {}} />,
    );
    expect(
      screen.getByRole("button", { name: "Video Compare" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Live Compare" }),
    ).toBeInTheDocument();
  });
});
