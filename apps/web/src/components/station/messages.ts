const messages: Record<string, string> = {
  station_mismatch: "This device has changed stations. Reopen the station before scanning again.",
  station_sign_in_required: "Station sign-in required. Sign in or pair this device again.",
  scan_not_permitted: "This scan is not permitted for this station account.",
  scan_conflict: "This scan action conflicts with an earlier action. Scan again.",
  scan_request_rejected: "This scan request cannot be processed. Check the label and scan again.",
  empty: "No label received. Scan again.",
  unknown_format: "Label not recognized. Scan a tote.",
  bad_field: "Label is incomplete or damaged.",
  unknown_tote: "Tote not found in this plant.",
  demo_requires_tote: "Scan a tote at this station.",
  operator_pin_required: "Enter your operator PIN to continue.",
  invalid_pin: "PIN not recognized. Try again.",
  not_manager: "A manager PIN is required.",
  locked: "Too many attempts. Wait five minutes before trying again.",
};
export const stationMessage = (reason: string) => messages[reason] ?? reason;
