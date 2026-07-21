import { redirect } from "next/navigation";

/** Password grants are disabled; Hugo owns identity and recovery. */
export default function SetPasswordPage() {
  redirect("/login?error=password_disabled");
}
