/** Outlook mail and calendar actions (Microsoft Graph v1.0, /me). */
import {
  bool,
  dateTime,
  emailList,
  freeSlots,
  int,
  isoWithOffset,
  objectSchema,
  offsetOf,
  optionalDateTime,
  optionalInt,
  optionalString,
  requireDateTime,
  requireId,
  requireString,
  seg,
  str,
  strList
} from "../common.js";
import { htmlToText } from "../trim.js";
import { ConnectorError, type ConnectorAction, type ConnectorActionContext } from "../types.js";

interface Recipient {
  emailAddress?: { address?: string; name?: string };
}
interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  isRead?: boolean;
  hasAttachments?: boolean;
  webLink?: string;
}
interface GraphEvent {
  id: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  location?: { displayName?: string };
  organizer?: Recipient;
  attendees?: Array<Recipient & { status?: { response?: string } }>;
  bodyPreview?: string;
  onlineMeeting?: { joinUrl?: string };
  webLink?: string;
  showAs?: string;
}

const me = (ctx: ConnectorActionContext) => `${ctx.base("graph")}/v1.0/me`;
const address = (r: Recipient | undefined) => (r?.emailAddress ? (r.emailAddress.name ? `${r.emailAddress.name} <${r.emailAddress.address}>` : r.emailAddress.address) : undefined);
const recipients = (list: string[]) => list.map((addressText) => ({ emailAddress: { address: addressText } }));
const MESSAGE_SELECT = "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,webLink";

function messageSummary(m: GraphMessage) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    from: address(m.from),
    to: m.toRecipients?.map(address),
    subject: m.subject,
    received: m.receivedDateTime,
    preview: m.bodyPreview,
    unread: m.isRead === false ? true : undefined,
    hasAttachments: m.hasAttachments || undefined,
    link: m.webLink
  };
}

function eventView(e: GraphEvent) {
  return {
    id: e.id,
    subject: e.subject,
    start: e.start?.dateTime ? `${e.start.dateTime} (${e.start.timeZone ?? "UTC"})` : undefined,
    end: e.end?.dateTime ? `${e.end.dateTime} (${e.end.timeZone ?? "UTC"})` : undefined,
    allDay: e.isAllDay || undefined,
    location: e.location?.displayName,
    organizer: address(e.organizer),
    attendees: e.attendees?.map((a) => `${a.emailAddress?.address}${a.status?.response && a.status.response !== "none" ? ` (${a.status.response})` : ""}`),
    preview: e.bodyPreview,
    joinUrl: e.onlineMeeting?.joinUrl,
    showAs: e.showAs,
    link: e.webLink
  };
}

/** Graph wants a local date-time plus a time zone; ISO with offset → UTC. */
function graphTime(iso: string, timeZone: string | undefined) {
  if (timeZone && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) return { dateTime: iso, timeZone };
  return { dateTime: new Date(Date.parse(iso)).toISOString().replace("Z", ""), timeZone: "UTC" };
}

const mailFields = {
  to: strList("Recipients (e-mail addresses)."),
  cc: strList("Cc recipients."),
  bcc: strList("Bcc recipients."),
  subject: str("Subject line."),
  body: str("Plain-text body.")
};

const eventFields = {
  subject: str("Title."),
  start: dateTime("Start."),
  end: dateTime("End."),
  timeZone: str("IANA or Windows time zone for start/end without an offset."),
  attendees: strList("Attendee e-mail addresses."),
  body: str("Description / agenda (plain text)."),
  location: str("Location."),
  online: bool("Add a Teams meeting link.")
};

export const outlookActions: ConnectorAction[] = [
  {
    name: "outlook_search",
    group: "mail_read",
    title: "Search Outlook mail",
    effect: "read",
    description:
      "Search the user's Outlook mailbox (Microsoft 365). Free-text query matches sender, subject and body (KQL works: from:anna subject:invoice). Without a query, lists the newest messages (optionally unread only).",
    inputSchema: objectSchema(
      {
        query: str("Search text / KQL."),
        folder: { type: "string", description: "Folder to look in (default all).", enum: ["inbox", "sentitems", "drafts", "archive", "deleteditems"] },
        unreadOnly: bool("Only unread messages (ignored with a query)."),
        maxResults: int("Max messages (default 10).", 1, 50)
      },
      []
    ),
    async run(input, ctx) {
      const folder = typeof input.folder === "string" ? input.folder : undefined;
      const query = optionalString(input, "query", 500);
      const base = folder ? `${me(ctx)}/mailFolders/${seg(folder)}/messages` : `${me(ctx)}/messages`;
      const result = await ctx.http.get<{ value?: GraphMessage[] }>(base, {
        $select: MESSAGE_SELECT,
        $top: optionalInt(input, "maxResults", 1, 50, 10),
        ...(query ? { $search: `"${query.replace(/"/g, "'")}"` } : { $orderby: "receivedDateTime desc", ...(input.unreadOnly === true ? { $filter: "isRead eq false" } : {}) })
      });
      const items = (result.value ?? []).map(messageSummary);
      return { summary: `Found ${items.length} message${items.length === 1 ? "" : "s"}.`, data: { messages: items } };
    }
  },
  {
    name: "outlook_read_message",
    group: "mail_read",
    title: "Read an Outlook e-mail",
    effect: "read",
    description: "Read one Outlook message in full (headers and plain-text body) by id from outlook_search.",
    inputSchema: objectSchema({ messageId: str("Message id.") }, ["messageId"]),
    async run(input, ctx) {
      const m = await ctx.http.get<GraphMessage>(`${me(ctx)}/messages/${seg(requireId(input, "messageId"))}`, { $select: `${MESSAGE_SELECT},body` }, { prefer: 'outlook.body-content-type="text"' });
      const body = m.body?.contentType === "html" ? htmlToText(m.body.content ?? "") : m.body?.content;
      return { data: { ...messageSummary(m), cc: m.ccRecipients?.map(address), preview: undefined, body } };
    }
  },
  {
    name: "outlook_create_draft",
    group: "mail_draft",
    title: "Create an Outlook draft",
    effect: "write",
    description: "Save an e-mail as a draft in the user's Outlook (nothing is sent). With replyToMessageId it drafts a reply in that conversation.",
    inputSchema: objectSchema({ ...mailFields, replyToMessageId: str("Draft a reply to this message id.") }, ["body"]),
    async run(input, ctx) {
      const replyTo = optionalString(input, "replyToMessageId", 500);
      const body = { contentType: "Text", content: requireString(input, "body", 50_000) };
      if (replyTo) {
        const draft = await ctx.http.post<GraphMessage>(`${me(ctx)}/messages/${seg(replyTo)}/createReply`, {});
        const to = emailList(input, "to");
        const updated = await ctx.http.patch<GraphMessage>(`${me(ctx)}/messages/${seg(draft.id)}`, { body, ...(to.length ? { toRecipients: recipients(to) } : {}) });
        return { summary: "Reply draft saved in Outlook.", data: { draftId: updated.id ?? draft.id, link: updated.webLink ?? draft.webLink } };
      }
      const draft = await ctx.http.post<GraphMessage>(`${me(ctx)}/messages`, {
        subject: requireString(input, "subject", 500),
        body,
        toRecipients: recipients(emailList(input, "to", true)),
        ccRecipients: recipients(emailList(input, "cc")),
        bccRecipients: recipients(emailList(input, "bcc"))
      });
      return { summary: "Draft saved in Outlook.", data: { draftId: draft.id, link: draft.webLink } };
    }
  },
  {
    name: "outlook_send",
    group: "mail_send",
    title: "Send an e-mail (Outlook)",
    effect: "write",
    risk: "high",
    description: "Send an e-mail from the user's Outlook right away (saved to Sent Items). Only when the user clearly wants it sent; otherwise create a draft.",
    inputSchema: objectSchema(mailFields, ["to", "subject", "body"]),
    async run(input, ctx) {
      await ctx.http.post(`${me(ctx)}/sendMail`, {
        message: {
          subject: requireString(input, "subject", 500),
          body: { contentType: "Text", content: requireString(input, "body", 50_000) },
          toRecipients: recipients(emailList(input, "to", true)),
          ccRecipients: recipients(emailList(input, "cc")),
          bccRecipients: recipients(emailList(input, "bcc"))
        },
        saveToSentItems: true
      });
      return "E-mail sent.";
    }
  },
  {
    name: "outlook_list_events",
    group: "calendar_read",
    title: "List Outlook calendar events",
    effect: "read",
    description: "List events in the user's Outlook calendar between two times (recurring events expanded).",
    inputSchema: objectSchema({ start: dateTime("Start of the window."), end: dateTime("End of the window."), maxResults: int("Max events (default 25).", 1, 100) }, ["start", "end"]),
    async run(input, ctx) {
      const events = await ctx.http.paginate<{ value?: GraphEvent[]; "@odata.nextLink"?: string }, GraphEvent>(
        {
          url: `${me(ctx)}/calendarView`,
          query: {
            startDateTime: new Date(Date.parse(requireDateTime(input, "start"))).toISOString(),
            endDateTime: new Date(Date.parse(requireDateTime(input, "end"))).toISOString(),
            $orderby: "start/dateTime",
            $top: 50,
            $select: "id,subject,start,end,isAllDay,location,organizer,attendees,bodyPreview,onlineMeeting,webLink,showAs"
          }
        },
        { items: (page) => page.value ?? [], next: (page) => page["@odata.nextLink"], max: optionalInt(input, "maxResults", 1, 100, 25) }
      );
      return { summary: `${events.length} event${events.length === 1 ? "" : "s"}.`, data: { events: events.map(eventView) } };
    }
  },
  {
    name: "outlook_find_free_time",
    group: "calendar_read",
    title: "Find free time (Outlook)",
    effect: "read",
    description: "Find open slots of a given length in the user's Outlook calendar, and optionally colleagues' (free/busy from Microsoft 365), within working hours.",
    inputSchema: objectSchema(
      {
        start: dateTime("Start of the search window."),
        end: dateTime("End of the search window (max 31 days later)."),
        durationMinutes: int("Length of the slot needed.", 5, 600),
        attendees: strList("Colleagues' e-mail addresses to include."),
        workdayStartHour: int("Earliest hour (local to start's offset), default 9.", 0, 23),
        workdayEndHour: int("Latest hour (local to start's offset), default 18.", 1, 24)
      },
      ["start", "end", "durationMinutes"]
    ),
    async run(input, ctx) {
      const start = requireDateTime(input, "start");
      const end = requireDateTime(input, "end");
      const from = Date.parse(start);
      const to = Date.parse(end);
      if (to <= from || to - from > 31 * 86400_000) throw new ConnectorError("bad_input", "The window must be positive and at most 31 days.");
      const self = ctx.connection.account;
      const others = emailList(input, "attendees");
      const busy: Array<{ start: number; end: number }> = [];
      if (self || others.length) {
        const result = await ctx.http.post<{ value?: Array<{ scheduleId?: string; scheduleItems?: Array<{ status?: string; start?: { dateTime?: string }; end?: { dateTime?: string } }> }> }>(
          `${me(ctx)}/calendar/getSchedule`,
          {
            schedules: [...(self ? [self] : []), ...others],
            startTime: { dateTime: new Date(from).toISOString().replace("Z", ""), timeZone: "UTC" },
            endTime: { dateTime: new Date(to).toISOString().replace("Z", ""), timeZone: "UTC" },
            availabilityViewInterval: 15
          }
        );
        for (const schedule of result.value ?? []) {
          for (const item of schedule.scheduleItems ?? []) {
            if (item.status === "free" || !item.start?.dateTime || !item.end?.dateTime) continue;
            busy.push({ start: Date.parse(`${item.start.dateTime}Z`), end: Date.parse(`${item.end.dateTime}Z`) });
          }
        }
      }
      if (!self) {
        // No account address yet: use the user's own events.
        const events = await ctx.http.get<{ value?: GraphEvent[] }>(`${me(ctx)}/calendarView`, { startDateTime: new Date(from).toISOString(), endDateTime: new Date(to).toISOString(), $top: 200, $select: "start,end,showAs" });
        for (const e of events.value ?? []) {
          if (e.showAs === "free" || !e.start?.dateTime || !e.end?.dateTime) continue;
          busy.push({ start: Date.parse(`${e.start.dateTime}Z`), end: Date.parse(`${e.end.dateTime}Z`) });
        }
      }
      const offset = offsetOf(start);
      const slots = freeSlots({
        from,
        to,
        busy,
        durationMinutes: optionalInt(input, "durationMinutes", 5, 600, 30),
        workdayStartHour: optionalInt(input, "workdayStartHour", 0, 23, 9),
        workdayEndHour: optionalInt(input, "workdayEndHour", 1, 24, 18),
        utcOffsetMinutes: offset
      });
      return { summary: `${slots.length} free slot${slots.length === 1 ? "" : "s"}.`, data: { slots: slots.map((s) => ({ start: isoWithOffset(s.start, offset), end: isoWithOffset(s.end, offset) })) } };
    }
  },
  {
    name: "outlook_create_event",
    group: "calendar_write",
    title: "Create an Outlook event",
    effect: "write",
    description: "Create an event in the user's Outlook calendar and invite attendees (they get an invitation), optionally with a Teams meeting.",
    inputSchema: objectSchema(eventFields, ["subject", "start", "end"]),
    async run(input, ctx) {
      const timeZone = optionalString(input, "timeZone", 64);
      const attendees = emailList(input, "attendees");
      const event = await ctx.http.post<GraphEvent>(`${me(ctx)}/events`, {
        subject: requireString(input, "subject", 500),
        start: graphTime(requireString(input, "start", 64), timeZone),
        end: graphTime(requireString(input, "end", 64), timeZone),
        ...(optionalString(input, "body", 8000) ? { body: { contentType: "Text", content: optionalString(input, "body", 8000) } } : {}),
        ...(optionalString(input, "location", 500) ? { location: { displayName: optionalString(input, "location", 500) } } : {}),
        ...(attendees.length ? { attendees: attendees.map((a) => ({ emailAddress: { address: a }, type: "required" })) } : {}),
        ...(input.online === true ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {})
      });
      return { summary: "Event created.", data: eventView(event) };
    }
  },
  {
    name: "outlook_update_event",
    group: "calendar_write",
    title: "Update an Outlook event",
    effect: "write",
    description: "Change an existing Outlook event (only the fields given). Attendees given replace the list.",
    inputSchema: objectSchema({ eventId: str("Event id from outlook_list_events."), ...eventFields }, ["eventId"]),
    async run(input, ctx) {
      const timeZone = optionalString(input, "timeZone", 64);
      const patch: Record<string, unknown> = {};
      const subject = optionalString(input, "subject", 500);
      if (subject) patch.subject = subject;
      const start = optionalDateTime(input, "start");
      const end = optionalDateTime(input, "end");
      if (start) patch.start = graphTime(start, timeZone);
      if (end) patch.end = graphTime(end, timeZone);
      const body = optionalString(input, "body", 8000);
      if (body !== undefined) patch.body = { contentType: "Text", content: body };
      const location = optionalString(input, "location", 500);
      if (location !== undefined) patch.location = { displayName: location };
      if (input.attendees !== undefined) patch.attendees = emailList(input, "attendees").map((a) => ({ emailAddress: { address: a }, type: "required" }));
      if (typeof input.online === "boolean") patch.isOnlineMeeting = input.online;
      if (Object.keys(patch).length === 0) return "Nothing to change.";
      const event = await ctx.http.patch<GraphEvent>(`${me(ctx)}/events/${seg(requireId(input, "eventId"))}`, patch);
      return { summary: "Event updated.", data: eventView(event) };
    }
  }
];
