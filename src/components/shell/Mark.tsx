/** Three strands converging into one: the shape of every mission. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M3 4.5c5 0 5 5.5 10 5.5" />
        <path d="M3 10h10" />
        <path d="M3 15.5c5 0 5-5.5 10-5.5" />
      </g>
      <circle cx="15" cy="10" r="2.25" fill="currentColor" />
    </svg>
  );
}
