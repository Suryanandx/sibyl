/** Common mail providers: their domain isn't a company name. */
const PERSONAL_DOMAINS = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|icloud|me|mac|proton|protonmail|aol|gmx|mail|yandex|zoho|fastmail|hey)\./i;

/** A starting organization name from the address: "ann@acme.com" → "Acme"; personal mail → "Ann's team". */
export function suggestOrgName(ticket: { email: string; name?: string }): string {
  const domain = ticket.email.split("@")[1] ?? "";
  if (domain && !PERSONAL_DOMAINS.test(domain)) {
    const labels = domain.toLowerCase().split(".");
    // "acme.co.uk", "acme.com.au": skip the two-part country suffix.
    const twoPart = labels.length >= 3 && labels[labels.length - 1]!.length === 2 && /^(co|com|org|net|ac|gov|edu|ltd|plc)$/.test(labels[labels.length - 2]!);
    const label = labels[labels.length - (twoPart ? 3 : 2)] ?? "";
    if (label) return label.charAt(0).toUpperCase() + label.slice(1);
  }
  const first = (ticket.name || ticket.email.split("@")[0] || "").split(/[\s._+-]+/)[0] ?? "";
  return first ? `${first.charAt(0).toUpperCase()}${first.slice(1)}'s team` : "";
}
