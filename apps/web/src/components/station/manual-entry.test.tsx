// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StationShell } from "./station-shell";
import { ENTRY_METHOD_HEADER, readTypedCode, withEntryMethod } from "./manual-entry";
afterEach(cleanup);

function shell(onScan = vi.fn(), paused = false) {
  render(
    <StationShell
      name="Test"
      site="Site"
      operator="Op"
      pending={0}
      onScan={onScan}
      paused={paused}
      next="Scan a tote"
      manualLabel="Tote number (INT-0002-1)"
      status={null}
    >
      <p>body</p>
    </StationShell>,
  );
  return onScan;
}

it("Enter manually opens a visible field; a short code goes to onScan as its label's QR text, manual", () => {
  const onScan = shell();
  const scanner = screen.getByLabelText("Station scanner") as HTMLInputElement;
  fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
  const field = screen.getByLabelText(/Tote number/) as HTMLInputElement;
  expect(field.getAttribute("inputmode")).toBe("text");
  expect(document.activeElement).toBe(field);
  // The hidden scanner input is paused so it cannot steal focus from the typed field.
  expect(scanner.disabled).toBe(true);
  fireEvent.change(field, { target: { value: "int-0001 3" } });
  fireEvent.submit(field.closest("form")!);
  expect(onScan).toHaveBeenCalledWith(
    "FL:TOTE:INT-0001:3",
    { ok: true, value: { kind: "TOTE", intakeNumber: "INT-0001", toteNo: 3, legacy: false } },
    "manual",
  );
  // Stays open for the next code, cleared.
  expect(field.value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: /Close/ }));
  expect(screen.queryByLabelText(/Tote number/)).toBeNull();
  expect(scanner.disabled).toBe(false);
  expect(document.activeElement).toBe(scanner);
});

it("a hardware scan is reported as scan", () => {
  const onScan = shell();
  const scanner = screen.getByLabelText("Station scanner");
  fireEvent.change(scanner, { target: { value: "042" } });
  fireEvent.keyDown(scanner, { key: "Enter" });
  expect(onScan).toHaveBeenCalledWith("042", expect.objectContaining({ ok: true }), "scan");
});

it("a malformed code is still submitted as typed, for the server to reject and log", () => {
  const onScan = shell();
  fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
  const field = screen.getByLabelText(/Tote number/);
  fireEvent.change(field, { target: { value: " STG-0001 " } });
  fireEvent.submit(field.closest("form")!);
  expect(onScan).toHaveBeenCalledWith("STG-0001", { ok: false, reason: "bad_field" }, "manual");
});

it("a paused station (operator PIN) does not take typed codes", () => {
  const onScan = shell(vi.fn(), true);
  fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
  const field = screen.getByLabelText(/Tote number/);
  fireEvent.change(field, { target: { value: "042" } });
  fireEvent.submit(field.closest("form")!);
  expect(onScan).not.toHaveBeenCalled();
});

it("withEntryMethod sets the header only for manual entries", () => {
  const query = { setHeader: vi.fn(() => query) };
  expect(withEntryMethod(query, "scan")).toBe(query);
  expect(withEntryMethod(query, undefined)).toBe(query);
  expect(query.setHeader).not.toHaveBeenCalled();
  expect(withEntryMethod(query, "manual")).toBe(query);
  expect(query.setHeader).toHaveBeenCalledWith(ENTRY_METHOD_HEADER, "manual");
});

it("readTypedCode uses the org slug and accepted kinds", () => {
  expect(readTypedCode("42", { orgSlug: "demo" }).text).toBe("FL:TAG:demo:042");
  expect(readTypedCode("23456789", { accept: ["PAIR"] }).text).toBe("FL:PAIR:23456789");
});

it("the next step line and step row show; Enter manually sits under the line with an Enter button", () => {
  render(
    <StationShell
      name="Test"
      site="Site"
      operator="Op"
      pending={0}
      onScan={vi.fn()}
      next="Weigh basket 005"
      steps={["Add baskets", "Weigh", "Send to Blast"]}
      step={1}
      status={null}
    >
      <p>body</p>
    </StationShell>,
  );
  expect(screen.getByTestId("next-step").textContent).toBe("Weigh basket 005");
  const steps = screen.getByRole("list", { name: "Steps" });
  expect(steps.textContent).toBe("1 Add baskets2 Weigh3 Send to Blast");
  expect(screen.getByText("2 Weigh").getAttribute("aria-current")).toBe("step");
  expect(screen.queryByText("Ready to scan")).toBeNull();
  const button = screen.getByRole("button", { name: "Enter manually" });
  expect(
    screen.getByTestId("next-step").compareDocumentPosition(button) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(button);
  // No station label given: the field still says what to type.
  expect(screen.getByLabelText(/Code printed beside the QR/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Enter" })).toBeTruthy();
});
