import { redirect } from "next/navigation";

export default function BasicChatRedirectPage() {
  redirect("/dashboard/playground");
}
