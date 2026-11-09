import { cn } from "@/lib/utils";
import { ProgressBar } from "./progress-bar";
import { SibylLoader } from "@/components/sibyl/SibylLoader";
import { useEffect, useState } from "react";

interface OverlayLoaderProps {
  text?: string;
  className?: string;
  show: boolean;
  showProgress?: boolean;
  duration?: number;
  extra_info?: string;
  onProgressComplete?: () => void;
}

export const OverlayLoader = ({
  text,
  className,
  show,
  showProgress = false,
  duration = 10,
  onProgressComplete,
  extra_info,
}: OverlayLoaderProps) => {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (show) {
      setIsVisible(true);
    } else {
      setIsVisible(false);
    }
  }, [show]);

  if (!show) return null;

  return (
    <div
      style={{
        zIndex: 1000,
      }}
      className={cn(
        "fixed inset-0 bg-black/70 z-50 flex items-center justify-center transition-opacity duration-300",
        isVisible ? "opacity-100" : "opacity-0"
      )}
    >
      <div
        className={cn(
          "flex flex-col items-center justify-center px-6 pt-6 pb-10 rounded-xl bg-[var(--surface)] shadow-2xl relative min-h-[240px] gap-5",
          "min-w-[280px] sm:min-w-[447px] border border-[color-mix(in_srgb,var(--border)_10%,transparent)] transition-all duration-400 ease-out",
          isVisible ? "opacity-100 scale-100" : "opacity-0 scale-90",
          className
        )}
      >
        <SibylLoader state="working" size={44} label="Loading" className="text-[var(--text)]" />
        {showProgress ? (
          <div className="w-full space-y-6 pt-4">
            <ProgressBar duration={duration} onComplete={onProgressComplete} />
            {text && (
              <div className="space-y-1">
                <p className="text-[var(--text)] text-base text-center font-medium font-manrope">
                  {text}
                </p>
                {extra_info && (
                  <p className="text-[color-mix(in_srgb,var(--text)_80%,transparent)] text-xs text-center font-medium font-manrope">
                    {extra_info}
                  </p>
                )}
              </div>
            )}
          </div>
        ) : ( 
          <>
            <p className="text-[var(--text)] text-base text-center font-medium font-manrope">
              {text}
            </p>
            {extra_info && (
              <p className="text-[color-mix(in_srgb,var(--text)_80%,transparent)] text-xs text-center font-medium font-manrope">
                {extra_info}
              </p>
            )}
          </>
        )}
      </div>

    </div>
  );
};
