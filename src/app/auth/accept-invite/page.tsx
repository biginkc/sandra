import { redirect } from "next/navigation";

/** Historical Sandra invite links no longer establish app sessions. */
export default function AcceptInvitePage() {
  redirect("/login?error=password_disabled");
}
