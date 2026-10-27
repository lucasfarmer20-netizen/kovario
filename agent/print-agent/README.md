# Filletry print agent (WP-08)

The plant LAN service receives tenant-scoped print jobs, claims them atomically,
then sends raw ZPL to TCP 9100 or downloads a PDF and submits it to an OS queue.
It never needs a Supabase service-role key.

## Build and install

`pnpm --filter print-agent build` compiles a single executable in
`agent/print-agent/dist/` with the pinned Bun compiler. Build on each target OS/CPU;
for cross-compilation use Bun's `--target=bun-linux-x64` (or the required target).
The ZPL path needs no other runtime. PDF printing requires `lp` on Linux/macOS or
SumatraPDF on Windows (`SUMATRA_PDF_PATH` names its executable). Install Chromium
on the **web rendering host**, not on the plant agent:
`pnpm --filter labels exec playwright install chromium`.

Set `SUPABASE_URL`, `SUPABASE_ANON_KEY` and optionally `PRINT_AGENT_HOME` in the
service account environment. The home defaults to `~/.filletry-print-agent` and
contains `session.json` (sensitive refreshable auth session) and `agent.log`.
Restrict that directory to the service account (0700 on Unix; Windows NTFS ACLs
with inheritance removed and access only for that account and administrators).
Files are created 0600 on Unix. Never copy session files into source control.
Logs only contain timestamp, fixed event name and job UUID; rotate at the OS level.

Deploy the `print-agent-pair` Edge Function with JWT verification disabled (the
one-time code authenticates initial redemption). For isolated local worktrees,
set `SUPABASE_PROJECT_ID` from `supabase/.env` before `supabase functions serve`;
the CLI function server does not resolve that file consistently. It uses the same runtime secret
names as other Supabase functions; no service credential is installed on the LAN.

1. A manager creates an agent at `/admin/print-agents`, selecting its site.
2. Request a pairing code (valid 10 minutes, single-use). Set
   `PRINT_AGENT_PAIRING_CODE` through a protected process environment, then run
   `filletry-print-agent --pair`. Do not put the code in command history.
3. The agent stores its scoped session and begins running. Re-pairing revokes old
   refresh sessions; already issued access tokens expire under the normal auth TTL.
4. Configure `/admin/printers`: same site and agent, kind `label_zpl`, address such
   as `192.168.x.x:9100`. PDF printers use kind `receipt_pdf` and their OS queue name.
5. Install `service/filletry-print-agent.service` on Linux (create the service user,
   protected environment file and home first), or run `service/install-task.ps1`
   with the absolute binary path on Windows. The Windows task starts at that user's
   logon; use an always-on signed-in plant account. Configure machine/user environment
   before starting it. Pair interactively as the same service/task account.

## Queue and failure behavior

Realtime INSERT notifications wake the agent; polling every five seconds recovers
missed events/reconnects. Heartbeat every 30 seconds; admin reports offline after
90 seconds. Claims use a single `FOR UPDATE SKIP LOCKED` transaction and bind to
one agent. Delivery is attempted initially plus three retries (1/2/4-second delays).
Acknowledgement retries are separate and never repeat physical delivery. Both
claim and acknowledgement have stable action ids across network retries.

A crash or network error after printer acceptance has an ambiguous physical
outcome: TCP/OS printing cannot guarantee exactly-once paper. Inspect output before
reprinting; retries can produce duplicates. Jobs stuck printing for ten minutes
are marked failed at heartbeat, never silently returned to queued. Admin shows
errors; enqueue a deliberate replacement through the caller's reprint action with
a **new** client_action_id. Existing jobs and receipts preserve their snapshots.
PDF URLs must be HTTPS signed URLs reachable by the plant, expire after the queue
can drain, and serve PDF bytes (max 20 MiB). Redirects are rejected; tokens/URLs
never enter agent logs. Delivery failure details use fixed, scrubbed messages.

## Zebra ZD421/ZP-450 operations

- **No driver for ZPL.** Send directly over raw TCP 9100. CUPS/vendor driver
  transformations cause gibberish. OS queues are only for PDF receipt printers.
- **FEED + PAUSE** can enter hex-dump/communications diagnostic mode. If it prints
  hexadecimal bytes instead of the tag, exit diagnostics/power-cycle according to
  the model's operator guide, then send a test label again.
- Load **4 × 6 inch** stock and calibrate media/gap sensing before testing. The
  template is 812 × 1218 dots at **203 dpi**; select 203-dpi hardware. A 300-dpi head
  requires rescaled templates. Check top-of-form and QR quiet zones after stock changes.
- Reserve the printer's LAN address; check TCP 9100 reachability and firewall rules.

## Verification and real-printer acceptance

Automated: `pnpm --filter labels test`, `pnpm --filter print-agent test`, and
`pnpm test:db` cover QR round trips, ZPL snapshots, fake TCP listener byte-for-byte
output, tenant/agent scope, concurrent claims, pairing and enqueue replay.

Manual ZD421 check (**pending plant hardware; not executed in development**):

1. Pair agent and configure a ZD421 at its real `192.168.x.x:9100` address as above.
2. At `/admin/printers`, select Test print. Confirm job moves queued → printing →
   done and one 4 × 6 tote tag prints. The dummy `INT-0000` is marked TEST PRINT;
   discard it and never use it on fish.
3. Verify ≥100-point intake number, QR readability, calibration, and no hex dump.
   Scan the QR; the rules parser must return the test intake and tote 1.
4. Queue a rendered real tote-tag fixture with FAST PASS / DIRTY / RIBBING /
   SMOKED EXCHANGE; verify all banners and species lines are legible. Record plant,
   date, printer DPI/IP (privately), operator and outcome in the PR acceptance notes.
5. Stop agent: refresh admin after 90 seconds and verify Offline. Restart, queue
   again, unplug/reconnect printer and verify failed/retry visibility. Inspect paper
   before deliberately reprinting an ambiguous job.
6. PDF queue: generate a receipt PDF, store privately, provide its signed HTTPS URL
   to Test print and verify the configured OS printer receives it.

## Caller interface and dependency boundary

`db.enqueuePrintJob(client, clientActionId, {printerId, kind, payloadType, payload,
copies, source})` is the shared WP-07/09/13/15 interface. Callers obtain printerId
from their site/device routing, render via `labels` (or `labels/zpl` for ZPL only),
and enqueue immutable snapshots. PDF callers store `receiptPdf` / `pickListPdf`
output in private storage and enqueue a signed URL. These station workflows are
owned by their work packages and are not implemented here. Asset tag sheets are
sent under the existing `location_tag` job kind (the domain enum has no asset kind).
Box labels and pick lists use the settlement boxing QR; no undocumented QR format
is invented. Intake status-page URLs are external URLs, not KV scanner codes.
The optional serial scale module and Labelary dev preview are not part of this WP.
Agent sessions therefore cannot read or write `scale_reading` yet; that scope must
be added explicitly when the scale module ships. New RLS tables deny agent access
by default through `app.enable_org_rls`.
