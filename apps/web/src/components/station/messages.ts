const messages: Record<string, string> = {
  empty: "No label received. Scan again.",
  unknown_format: "Label not recognized. Scan a tote tag.",
  bad_field: "Label is incomplete or damaged.",
  unknown_tote: "Tote not found in this plant.",
  demo_requires_tote: "Scan a tote tag at this station.",
  operator_pin_required: "Enter your operator PIN to continue.",
  invalid_pin: "PIN not recognized. Try again.",
  not_manager: "A manager PIN is required.",
  locked: "Too many attempts. Wait five minutes before trying again.",
};
export const stationMessage = (reason: string) => messages[reason] ?? reason;
