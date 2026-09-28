import { SignInForm, SignOutButton } from "@/components/owner-sign-in";
import { demoMode, isOwner } from "@/lib/owner";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function OwnerPage() {
  const owner = await isOwner();
  return (
    <div className="max-w-sm mx-auto pt-12">
      <h1 className="font-sans text-2xl text-ink tracking-tight mb-2" style={{ fontStretch: "100%" }}>
        {owner ? "You're signed in" : "Sign in"}
      </h1>
      {!demoMode() ? (
        <p className="text-xs text-dim">No owner token is set, so everyone has full access here.</p>
      ) : owner ? (
        <div className="space-y-4">
          <p className="text-xs text-dim">You can run the agent, deploy strategies and manage portfolios.</p>
          <SignOutButton />
        </div>
      ) : (
        <>
          <p className="text-xs text-dim mb-5">
            The demo is read-only. The owner can sign in to run the agent and manage paper portfolios.
          </p>
          <SignInForm />
        </>
      )}
    </div>
  );
}
