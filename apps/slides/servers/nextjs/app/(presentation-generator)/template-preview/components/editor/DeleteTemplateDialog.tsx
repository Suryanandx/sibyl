"use client";

import { Loader2, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type DeleteTemplateDialogProps = {
  isDeleting: boolean;
  open: boolean;
  templateName: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
};

export function DeleteTemplateDialog({
  isDeleting,
  open,
  templateName,
  onConfirm,
  onOpenChange,
}: DeleteTemplateDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isDeleting) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent
        className="w-[calc(100vw-32px)] max-w-[432px] gap-0 rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-0 shadow-[0_24px_64px_rgba(16,24,40,0.20)]"
      >
        <div className="p-6 pb-0">
          <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--canvas)] text-[var(--danger)]">
            <Trash2 className="h-5 w-5" />
          </div>

          <DialogHeader className="space-y-2 text-left">
            <DialogTitle className="text-[18px] font-semibold leading-[26px] tracking-normal text-[var(--text)]">
              Delete template?
            </DialogTitle>
            <DialogDescription className="text-[14px] leading-[20px] text-[var(--text-2)]">
              This will permanently delete{" "}
              <span className="font-medium text-[var(--text)]">{templateName}</span>
              . This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
        </div>

        <DialogFooter className="mt-8 gap-3 border-t border-[var(--border)] bg-[var(--canvas)] px-6 py-4 sm:flex-row sm:justify-end sm:space-x-0">
          <button
            className="inline-flex h-10 items-center justify-center rounded-[8px] border border-[var(--border-strong)] bg-[var(--surface)] px-4 text-[14px] font-medium text-[var(--text)] shadow-sm transition-colors hover:bg-[var(--canvas)] disabled:pointer-events-none disabled:opacity-60"
            disabled={isDeleting}
            onClick={() => onOpenChange(false)}
            type="button"
          >
            Cancel
          </button>
          <button
            className="inline-flex h-10 items-center justify-center gap-2 rounded-[8px] border border-[var(--danger)] bg-[var(--danger)] px-4 text-[14px] font-medium text-white shadow-sm transition-colors hover:bg-[var(--danger)] disabled:pointer-events-none disabled:opacity-70"
            disabled={isDeleting}
            onClick={onConfirm}
            type="button"
          >
            {isDeleting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            {isDeleting ? "Deleting" : "Delete Template"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
