/**
 * Notifications: one record, one publish path (`notify`), one mailer and one
 * notifier registry for every feature. See service.ts.
 */
import { createMailer, type Mailer, type MailTransport } from "./mailer.js";
import { NotificationService, type NotificationServiceOptions } from "./service.js";

export * from "./mailer.js";
export * from "./notices.js";
export * from "./notifiers.js";
export * from "./service.js";
export * from "./ws.js";

/** Create the service with the gateway's one mailer (SIBYL_SMTP_URL; `transport` replaces SMTP in tests). */
export function installNotifications(options: Omit<NotificationServiceOptions, "mailer"> & { mailer?: Mailer; transport?(): Promise<MailTransport> }): NotificationService {
  const { transport, mailer: given, ...rest } = options;
  const mailer = given ?? createMailer({ env: options.env, ...(transport ? { transport } : {}) });
  return new NotificationService({ ...rest, ...(mailer ? { mailer } : {}) });
}
