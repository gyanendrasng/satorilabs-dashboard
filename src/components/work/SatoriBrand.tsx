'use client';

/**
 * Satori Labs brand mark — an enso-inspired ring (Zen circle, nodding to
 * "satori" / enlightenment) with a small amber spark, plus the wordmark.
 * Pure inline SVG + CSS; no asset files. Used only by the Work v2 page.
 */
export function SatoriMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      {/* enso ring — intentionally open at the top-right, hand-brush feel */}
      <path
        className="s-enso-ring"
        d="M34 9.5 A18 18 0 1 0 41 27"
        stroke="var(--s-amber)"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      {/* spark / point of insight */}
      <circle cx="38.5" cy="13.5" r="3.2" fill="var(--s-sand)" />
    </svg>
  );
}

export function SatoriWordmark({ markSize = 32 }: { markSize?: number }) {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <SatoriMark size={markSize} />
      <div className="leading-none">
        <div
          className="text-[17px] font-semibold tracking-tight"
          style={{ color: 'var(--s-text)' }}
        >
          Satori<span style={{ color: 'var(--s-amber)' }}> Labs</span>
        </div>
        <div
          className="text-[10px] uppercase tracking-[0.22em] mt-0.5"
          style={{ color: 'var(--s-muted-2)' }}
        >
          SAP Automation
        </div>
      </div>
    </div>
  );
}
