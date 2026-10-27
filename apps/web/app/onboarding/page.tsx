import { randomUUID } from "node:crypto";
import { Constants, isManager } from "db";
import Link from "next/link";
import { isPlanCode } from "payments";
import { createDevice } from "@/app/admin/devices/actions";
import { ActionForm } from "@/components/admin/action-form";
import { RateLinesForm } from "@/components/admin/rate-lines-form";
import { TimezoneSelect } from "@/components/admin/timezone-select";
import { PlanPicker } from "@/components/billing/plan-picker";
import { Input, Label, Select } from "@/components/ui/form";
import { requireStaff, type StaffSession } from "@/lib/auth";
import { ONBOARDING_STEPS, onboardingStep, type OnboardingStep } from "@/lib/onboarding";
import { cn } from "@/lib/utils";
import { createOrganisation } from "./actions";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string }>;
}) {
  const session = await requireStaff();
  const { claims } = session;
  const step = onboardingStep(claims !== null, (await searchParams).step);

  if (claims?.appRole === "station") {
    return (
      <Shell step={step}>
        This is a station device; sign in on a staff account to set up a plant.
      </Shell>
    );
  }
  if (step !== "plant" && !isManager(claims)) {
    return (
      <Shell step={step}>
        <p>
          Your account already belongs to a plant as {claims?.appRole}. Ask its owner for changes,
          or{" "}
          <Link href="/onboarding?step=plant" className="underline">
            set up another plant
          </Link>
          .
        </p>
      </Shell>
    );
  }

  return (
    <Shell step={step} hasOrg={claims !== null}>
      {step === "plant" ? (
        <PlantStep />
      ) : step === "rates" ? (
        <RatesStep session={session} />
      ) : step === "device" ? (
        <DeviceStep session={session} />
      ) : (
        <PlanStep session={session} />
      )}
    </Shell>
  );
}

function Shell({
  step,
  hasOrg = false,
  children,
}: {
  step: OnboardingStep;
  hasOrg?: boolean;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">Set up your plant</h1>
      <ol className="flex flex-wrap gap-4 text-sm">
        {ONBOARDING_STEPS.map((s, i) => (
          <li
            key={s.key}
            className={cn(s.key === step ? "font-semibold" : "text-muted-foreground")}
          >
            {hasOrg && s.key !== "plant" ? (
              <Link href={`/onboarding?step=${s.key}`}>{`${i + 1}. ${s.label}`}</Link>
            ) : (
              `${i + 1}. ${s.label}`
            )}
          </li>
        ))}
      </ol>
      {children}
    </main>
  );
}

function Next({ to, label }: { to: string; label: string }) {
  return (
    <Link
      href={to}
      className="inline-flex h-10 w-fit items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
    >
      {label}
    </Link>
  );
}

function PlantStep() {
  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        We create your plant with every species, incoming condition, processing method and yield
        factor from the standard processing rules, a default rate card and your first site. You can
        change all of it later under Admin.
      </p>
      <ActionForm
        action={createOrganisation}
        actionId={randomUUID()}
        submitLabel="Create plant"
        className="flex-col items-stretch"
      >
        <Label>
          Plant (business) name
          <Input name="name" required maxLength={120} placeholder="Kenai Custom Seafoods" />
        </Label>
        <Label>
          Short name (used in labels and your status page; blank = from the name)
          <Input
            name="slug"
            maxLength={40}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            placeholder="kenai-seafoods"
          />
        </Label>
        <Label>
          Time zone
          <TimezoneSelect name="timezone" defaultValue="America/Anchorage" />
        </Label>
        <Label>
          Your name
          <Input name="display_name" required maxLength={80} />
        </Label>
        <Label>
          First site
          <Input name="site_name" required maxLength={80} defaultValue="Main" />
        </Label>
      </ActionForm>
    </section>
  );
}

async function RatesStep({ session }: { session: StaffSession }) {
  const [{ data: card }, { data: methods }] = await Promise.all([
    session.supabase
      .from("rate_card")
      .select("id, name, rate_card_line(key, amount)")
      .eq("is_default", true)
      .maybeSingle(),
    session.supabase.from("processing_method").select("code, name, sort"),
  ]);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-semibold">Default rates</h2>
      <p className="text-sm text-muted-foreground">
        Prices per lb for each processing method, plus Fast Pass, ribbing and cold storage. They
        show on the intake screen, the receipt and the status page. Add season cards later under
        Rate cards.
      </p>
      {card ? (
        <RateLinesForm
          cardId={card.id}
          lines={card.rate_card_line}
          methods={methods ?? []}
          submitLabel="Save rates"
        />
      ) : (
        <p className="text-destructive">No default rate card found.</p>
      )}
      <Next to="/onboarding?step=device" label="Next: first station" />
    </section>
  );
}

async function DeviceStep({ session }: { session: StaffSession }) {
  const [{ data: devices }, { data: sites }] = await Promise.all([
    session.supabase.from("device").select("id, name, station, paired_at").order("name"),
    session.supabase.from("site").select("id, name, is_default").order("name"),
  ]);
  const defaultSite = sites?.find((s) => s.is_default)?.id ?? "";
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-semibold">First station</h2>
      <p className="text-sm text-muted-foreground">
        Register the tablet for your first station (usually Intake). Pair it from{" "}
        <Link href="/admin/devices" className="underline">
          Devices
        </Link>{" "}
        by scanning the QR code on the tablet.
      </p>
      <ActionForm action={createDevice} actionId={randomUUID()} submitLabel="Add station">
        <Label>
          Name
          <Input name="name" required maxLength={80} defaultValue="Intake 1" />
        </Label>
        <Label>
          Station
          <Select name="station" defaultValue="intake">
            {Constants.public.Enums.device_station.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Label>
        <Label>
          Site
          <Select name="site_id" defaultValue={defaultSite}>
            {(sites ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Label>
      </ActionForm>
      {devices && devices.length > 0 ? (
        <ul className="text-sm">
          {devices.map((d) => (
            <li key={d.id}>
              {d.name} · {d.station} · {d.paired_at ? "paired" : "not paired yet"}
            </li>
          ))}
        </ul>
      ) : null}
      <Next to="/onboarding?step=plan" label="Next: choose a plan" />
    </section>
  );
}

async function PlanStep({ session }: { session: StaffSession }) {
  const { data: org } = await session.supabase.from("org").select("plan").maybeSingle();
  const plan = isPlanCode(org?.plan) ? org.plan : null;
  const isOwner = session.claims?.appRole === "owner";
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-semibold">Choose a plan</h2>
      <p className="text-sm text-muted-foreground">
        Payment is handled by Stripe. You can change or cancel any time from Subscription.
      </p>
      <PlanPicker current={plan} canBuy={isOwner && !plan} returnTo="onboarding" />
      <Next to="/admin" label={plan ? "Go to admin" : "Skip for now"} />
    </section>
  );
}
