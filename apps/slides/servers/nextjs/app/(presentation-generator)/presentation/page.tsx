'use client'
import { goToLibrary } from "@/utils/appLinks";
import React from "react";
import PresentationPage from "./components/PresentationPage";
import { Button } from "@/components/ui/button";
import { useRouter, useSearchParams } from "next/navigation";
import "../utils/prism-languages";
const page = () => {

  const router = useRouter();
  const params = useSearchParams();
  const queryId = params.get("id");
  if (!queryId) {
    return (
      <div className="flex flex-col items-center justify-center h-screen font-syne">
        <h1 className="text-2xl font-bold">No presentation id found</h1>
        <p className="text-[var(--text-2)] pb-4">Please try again</p>
        <Button onClick={() => goToLibrary()}>Go to home</Button>
      </div>
    );
  }
  return (

    <PresentationPage presentation_id={queryId} />

  );
};
export default page;
