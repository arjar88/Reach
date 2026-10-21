import { SignInForm } from "./form";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ "check-email"?: string }> }) {
  const params = await searchParams;
  return <SignInForm checkEmail={params["check-email"] === "1"} />;
}
