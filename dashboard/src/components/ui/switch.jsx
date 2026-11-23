"use client";

/**
 * Switch from shadcn/ui (https://ui.shadcn.com/docs/components/switch, MIT), which wraps the Radix
 * UI Switch primitive. Copied in as source the way the shadcn CLI does, converted from TSX to JS,
 * and with its theme tokens (primary, input, ring, background) replaced by this dashboard's zinc /
 * emerald palette because the project does not define shadcn's CSS variables.
 */

import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

function Switch({ className, size = "default", ...props }) {
    return (
        <SwitchPrimitive.Root
            data-slot="switch"
            data-size={size}
            className={cn(
                "peer group/switch inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-zinc-400/60 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-[1.15rem] data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-[state=checked]:bg-emerald-600 data-[state=unchecked]:bg-zinc-700",
                className
            )}
            {...props}
        >
            <SwitchPrimitive.Thumb
                data-slot="switch-thumb"
                className={cn(
                    "pointer-events-none block rounded-full bg-white ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0"
                )}
            />
        </SwitchPrimitive.Root>
    );
}

export { Switch };
