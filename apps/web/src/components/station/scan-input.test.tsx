// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ScanInput } from "./scan-input";
afterEach(cleanup);
it("Enter submits once, clears and keeps scanner focused after a render and overlay close", () => {
  const onScan = vi.fn();
  const { rerender } = render(<ScanInput onScan={onScan} />);
  const input = screen.getByLabelText("Station scanner") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "KV:TOTE:INT-0001:1" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onScan).toHaveBeenCalledTimes(1);
  expect(input.value).toBe("");
  rerender(<ScanInput onScan={onScan} paused />);
  expect(input.disabled).toBe(true);
  rerender(<ScanInput onScan={onScan} />);
  expect(document.activeElement).toBe(input);
});
