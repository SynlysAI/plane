import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../utils";

export const LIST_CONTROL_CLASS_NAME =
  "h-8 w-full min-w-0 rounded-md border border-subtle-1 bg-layer-2 px-2.5 py-0 text-13 text-primary placeholder:text-tertiary outline-none transition-colors focus:border-accent-strong focus:ring-1 focus:ring-accent-strong disabled:cursor-not-allowed disabled:bg-layer-disabled disabled:text-disabled";

/** Each field wraps as a unit, keeping its label above its control. */
export function ListFilterField({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex w-[calc(50%-0.375rem)] max-w-full min-w-0 flex-col gap-1.5 sm:w-32", className)}>
      <span className="text-11 leading-4 font-medium text-secondary">{label}</span>
      {children}
    </label>
  );
}

export const ListFilterInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function ListFilterInput({ className, type, ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          LIST_CONTROL_CLASS_NAME,
          type === "file" &&
            "px-0 leading-[30px] file:mr-2 file:h-full file:border-0 file:border-r file:border-subtle-1 file:bg-surface-2 file:px-2.5 file:text-12 file:text-secondary",
          className
        )}
        {...props}
      />
    );
  }
);

export const ListFilterSelect = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function ListFilterSelect({ className, children, ...props }, ref) {
    return (
      <span className="relative block w-full min-w-0">
        <select ref={ref} className={cn(LIST_CONTROL_CLASS_NAME, "appearance-none pr-8", className)} {...props}>
          {children}
        </select>
        <ChevronDown aria-hidden="true" className="pointer-events-none absolute top-2 right-2 size-4 text-tertiary" />
      </span>
    );
  }
);

export function ListFilterCheckbox({
  label,
  className,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & { label: string }) {
  return (
    <label className={cn("flex h-8 max-w-full items-center gap-2 text-13 text-secondary", className)}>
      <input type="checkbox" className="accent-accent-primary size-4 shrink-0" {...props} />
      <span>{label}</span>
    </label>
  );
}
