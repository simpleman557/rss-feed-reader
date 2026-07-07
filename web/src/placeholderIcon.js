const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect width="24" height="24" rx="3" fill="#e2e2e6"/>
  <circle cx="8.5" cy="8.5" r="1.6" fill="#9ca3af"/>
  <path d="M3 17l5.5-5.5a1 1 0 0 1 1.4 0L14 15.5l2.5-2.5a1 1 0 0 1 1.4 0L21 16" stroke="#9ca3af" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const PLACEHOLDER_ICON = `data:image/svg+xml,${encodeURIComponent(PLACEHOLDER_SVG)}`;
