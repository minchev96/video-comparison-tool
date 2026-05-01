import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import App from "../../App.jsx";

describe("LiveComparePage", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async (url, options) => {
      if (url === "/api/live/session" && options?.method === "POST") {
        return {
          ok: true,
          json: async () => ({
            sessionId: "session-123",
            leftProxyBase: "/proxy/left/session-123",
            rightProxyBase: "/proxy/right/session-123",
            leftPath: "/left",
            rightPath: "/right",
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows validation error when URLs are missing", () => {
    render(
      <MemoryRouter initialEntries={["/live"]}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load URLs" }));

    expect(
      screen.getByText("Please provide both URLs before loading."),
    ).toBeInTheDocument();
  });

  it("accepts urls and displays loaded names", () => {
    render(
      <MemoryRouter initialEntries={["/live"]}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("URL 1"), {
      target: { value: "https://cdn.example.com/alpha.mp4" },
    });
    fireEvent.change(screen.getByLabelText("URL 2"), {
      target: { value: "https://cdn.example.com/beta.mp4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load URLs" }));

    expect(screen.getByText("Left: cdn.example.com")).toBeInTheDocument();
    expect(screen.getByText("Right: cdn.example.com")).toBeInTheDocument();
    expect(screen.getByText("Mirrored Websites")).toBeInTheDocument();
  });

  it("shows the viewport preset control and applies the selected preset", async () => {
    render(
      <MemoryRouter initialEntries={["/live"]}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("URL 1"), {
      target: { value: "https://cdn.example.com/alpha.mp4" },
    });
    fireEvent.change(screen.getByLabelText("URL 2"), {
      target: { value: "https://cdn.example.com/beta.mp4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load URLs" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Viewport preset")).toBeInTheDocument(),
    );

    const preset = screen.getByLabelText("Viewport preset");
    expect(preset).toHaveValue("default");

    fireEvent.change(preset, { target: { value: "iphone-se" } });

    const stage = document.querySelector(".website-stage.active");
    expect(stage).toHaveStyle("aspect-ratio: 375 / 667");
  });
});
