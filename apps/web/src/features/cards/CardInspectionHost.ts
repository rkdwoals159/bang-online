import { createContext } from "react";

/** Keep inspection dialogs outside compact seat, hand and action layouts. */
export const CardInspectionHost = createContext<HTMLElement | null>(null);
