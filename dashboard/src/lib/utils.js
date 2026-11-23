import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui's standard class-name helper: joins conditional classes and resolves Tailwind conflicts. */
export function cn(...inputs) {
    return twMerge(clsx(inputs));
}
