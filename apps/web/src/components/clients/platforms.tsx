import { Platform, PLATFORM_LABEL } from "@enmo/shared";
import { Checkbox } from "@/components/ui/Checkbox";
import { cx } from "@/components/ui/cx";
import { FieldError } from "@/components/ui/Field";

/** Platform colours come from the theme (IG #C13584, FB #5B7FF0, TikTok #25F4EE). */
export const PLATFORM_DOT: Readonly<Record<Platform, string>> = {
  INSTAGRAM: "bg-ig",
  FACEBOOK: "bg-fb",
  TIKTOK: "bg-tt",
};

export function PlatformBadges({
  platforms,
  className,
}: {
  platforms: readonly Platform[];
  className?: string;
}) {
  return (
    <ul className={cx("flex flex-wrap gap-1.5", className)}>
      {platforms.map((platform) => (
        <li
          key={platform}
          className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line px-2.5 text-[11px] text-steel"
        >
          <span aria-hidden className={cx("size-1.5 rounded-full", PLATFORM_DOT[platform])} />
          {PLATFORM_LABEL[platform]}
        </li>
      ))}
    </ul>
  );
}

/** Checkbox group for Client.enabledPlatforms, in the canonical platform order. */
export function PlatformPicker({
  value,
  onChange,
  disabled,
  error,
}: {
  value: readonly Platform[];
  onChange: (next: Platform[]) => void;
  disabled?: boolean;
  error?: string | null;
}) {
  function toggle(platform: Platform, checked: boolean) {
    const next = new Set(value);
    if (checked) next.add(platform);
    else next.delete(platform);
    onChange(Platform.options.filter((option) => next.has(option)));
  }

  return (
    <fieldset className="flex flex-col gap-2.5" disabled={disabled}>
      <legend className="mb-2.5 text-xs font-medium tracking-wide text-steel">Platforms</legend>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {Platform.options.map((platform) => (
          <Checkbox
            key={platform}
            label={
              <span className="inline-flex items-center gap-2">
                <span aria-hidden className={cx("size-1.5 rounded-full", PLATFORM_DOT[platform])} />
                {PLATFORM_LABEL[platform]}
              </span>
            }
            checked={value.includes(platform)}
            onChange={(event) => toggle(platform, event.target.checked)}
          />
        ))}
      </div>
      {error ? <FieldError>{error}</FieldError> : null}
    </fieldset>
  );
}
