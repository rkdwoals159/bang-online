import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface AccessibleButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "aria-labelledby"> {
  /** Required name for icon-only or otherwise unlabeled button content. */
  readonly accessibleName: string;
  readonly children?: ReactNode;
}

/**
 * A native button for controls whose visible content does not name the action.
 * Keep accessibleName aligned with any visible button text.
 */
export function AccessibleButton({
  accessibleName,
  children,
  type = "button",
  ...buttonProps
}: AccessibleButtonProps) {
  const name = accessibleName.trim();
  if (!name) {
    throw new Error("AccessibleButton requires a non-empty accessibleName.");
  }

  return (
    <button {...buttonProps} type={type} aria-label={name}>
      {children}
    </button>
  );
}
