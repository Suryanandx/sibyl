"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import styles from "../../../features/signup/signup.module.css";
import { AuthCard } from "../../login/auth-ui";

/** /signup/check?email= — a sign-in or sign-up link is on its way. */
export default function CheckEmailPage() {
  const [email, setEmail] = useState("");
  const [signIn, setSignIn] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setEmail(params.get("email") ?? "");
    setSignIn(params.get("signin") === "1");
  }, []);
  return (
    <AuthCard
      title="Check your email"
      lead={
        <>
          If <strong>{email || "that address"}</strong> {signIn ? "has a Sibyl account" : "is yours"}, a link is on its way. It works once, for 15 minutes.
        </>
      }
    >
      <span className={styles.sent} aria-hidden>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6.5h16v11H4Z M4.5 7l7.5 6 7.5-6" />
        </svg>
      </span>
      <p className="identFoot">
        Wrong address? <Link href={signIn ? "/login" : `/signup?email=${encodeURIComponent(email)}`}>Start again</Link>
      </p>
    </AuthCard>
  );
}
