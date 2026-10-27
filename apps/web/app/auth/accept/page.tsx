import { AcceptInvite } from "./accept-invite";

export default function AcceptInvitePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Welcome to Filletry</h1>
      <AcceptInvite />
    </main>
  );
}
