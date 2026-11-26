"use client";

export function SignOutButton() {
  return (
    <button
      className="underline"
      onClick={async () => {
        await fetch("/api/access/logout", { method: "POST" }).catch(() => {});
        window.location.assign("/access");
      }}
    >
      Sign out
    </button>
  );
}
