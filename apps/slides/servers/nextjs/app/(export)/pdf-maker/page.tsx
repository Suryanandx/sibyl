'use client'
import { goToLibrary } from "@/utils/appLinks";
import React from "react";

import { Button } from "@/components/ui/button";
import { useRouter, useSearchParams } from "next/navigation";
import PdfMakerPage from "./PdfMakerPage";
const page = () => {

    const router = useRouter();
    const params = useSearchParams();
    const queryId = params.get("id");
    const exportCookie = params.get("exportCookie") ?? undefined;
    if (!queryId) {
        return (
            <div className="flex flex-col items-center justify-center h-screen">
                <h1 className="text-2xl font-bold">No presentation id found</h1>
                <p className="text-gray-500 pb-4">Please try again</p>
                <Button onClick={() => goToLibrary()}>Go to home</Button>
            </div>
        );
    }
    return (
        <PdfMakerPage presentation_id={queryId} exportCookie={exportCookie} />
    );
};
export default page;
