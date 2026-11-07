export function ArrowIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function BowlIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 11h18a9 9 0 0 1-18 0Z" />
      <path d="M8 7.5c0-1 .8-1.5.8-2.5M12 7.5c0-1 .8-1.5.8-2.5M16 7.5c0-1 .8-1.5.8-2.5" />
    </svg>
  );
}

export function CalendarIcon({ size = 20 }: { size?: number }) {
  return (
    <svg className={size > 20 ? "ic" : undefined} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}

export function TagIcon() {
  return (
    <svg className="ic" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.5 13.2 13.2 20.5a1.8 1.8 0 0 1-2.5 0L3.5 13.3V3.5h9.8l7.2 7.2a1.8 1.8 0 0 1 0 2.5Z" />
      <circle cx="8" cy="8" r="1.4" />
    </svg>
  );
}

export function ChevronIcon() {
  return (
    <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function BagIcon() {
  return (
    <svg width="22" height="28" viewBox="0 0 22 28" fill="none" stroke="#A39C91" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5h16l1.5 19.5a2 2 0 0 1-2 2.2H3.5a2 2 0 0 1-2-2.2Z" />
      <path d="M3 5l1.6-3h12.8L19 5" />
      <path d="M7 13.5h8M8.5 17.5h5" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}
