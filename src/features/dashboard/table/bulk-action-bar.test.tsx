import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BulkActionBar } from "./bulk-action-bar";

describe("BulkActionBar", () => {
  it("renders the selected count", () => {
    render(<BulkActionBar selectedCount={3} isPending={false} onAction={vi.fn()} onClearSelection={vi.fn()} />);
    expect(screen.getByText("3개 선택됨")).toBeInTheDocument();
  });

  it("calls onAction with the clicked action's type", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<BulkActionBar selectedCount={2} isPending={false} onAction={onAction} onClearSelection={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "일시정지" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("pause");

    await user.click(screen.getByRole("button", { name: "중지" }));
    expect(onAction).toHaveBeenLastCalledWith("stop");
  });

  it("calls onClearSelection when the clear button is clicked", async () => {
    const user = userEvent.setup();
    const onClearSelection = vi.fn();
    render(<BulkActionBar selectedCount={1} isPending={false} onAction={vi.fn()} onClearSelection={onClearSelection} />);

    await user.click(screen.getByRole("button", { name: "선택 해제" }));
    expect(onClearSelection).toHaveBeenCalledOnce();
  });

  it("disables every bulk action button while a bulk mutation is pending", () => {
    render(<BulkActionBar selectedCount={2} isPending onAction={vi.fn()} onClearSelection={vi.fn()} />);

    expect(screen.getByRole("button", { name: "일시정지" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "재개" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "재시도" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "중지" })).toBeDisabled();
  });

  it("keeps the clear-selection button enabled while a bulk mutation is pending", () => {
    render(<BulkActionBar selectedCount={2} isPending onAction={vi.fn()} onClearSelection={vi.fn()} />);
    expect(screen.getByRole("button", { name: "선택 해제" })).toBeEnabled();
  });
});
