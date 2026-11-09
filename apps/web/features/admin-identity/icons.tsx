"use client";

/** Section icons for sign-in security, single sign-on, provisioning and session policies (24×24 line style). */
function Line({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

/** A door with an arrow in: signing in through another service. */
export const SsoIcon = ({ size }: { size?: number }) => <Line size={size} d="M14 4h4.5a1.5 1.5 0 0 1 1.5 1.5v13a1.5 1.5 0 0 1-1.5 1.5H14 M4 12h11 M11 8l4 4-4 4" />;

/** Two arrows going round: syncing people from the identity provider. */
export const ScimIcon = ({ size }: { size?: number }) => (
  <Line size={size} d="M4.5 10a7.5 7.5 0 0 1 13.4-3.6L20 8.5 M20 4v4.5h-4.5 M19.5 14a7.5 7.5 0 0 1-13.4 3.6L4 15.5 M4 20v-4.5h4.5" />
);

/** A clock: how long sessions last. */
export const SessionIcon = ({ size }: { size?: number }) => <Line size={size} d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M12 7v5l3 2" />;

/** A shield with a tick: two-step verification. */
export const ShieldIcon = ({ size }: { size?: number }) => <Line size={size} d="M12 3 5 6v5.5c0 4.2 3 7.9 7 9.5 4-1.6 7-5.3 7-9.5V6l-7-3Z M9 12l2 2 4-4" />;
