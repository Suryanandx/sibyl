/** Google Calendar actions (Calendar API v3). */
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
import { ConnectorError, type ConnectorAction, type ConnectorActionContext } from "../types.js";

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ email?: string; responseStatus?: string; displayName?: string; self?: boolean }>;
  organizer?: { email?: string };
}

const api = (ctx: ConnectorActionContext) => `${ctx.base("calendar")}/calendar/v3`;

function eventView(event: GoogleEvent) {
  return {
    id: event.id,
    summary: event.summary,
    start: event.start?.dateTime ?? event.start?.date,
    end: event.end?.dateTime ?? event.end?.date,
    allDay: event.start?.date ? true : undefined,
    location: event.location,
    description: event.description,
    meetLink: event.hangoutLink,
    organizer: event.organizer?.email,
    attendees: event.attendees?.map((a) => `${a.email}${a.responseStatus ? ` (${a.responseStatus})` : ""}`),
    link: event.htmlLink,
    status: event.status === "confirmed" ? undefined : event.status
  };
}

function timeField(value: string, timeZone: string | undefined) {
  // All-day events: a bare date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  return { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

const eventFields = {
  calendarId: str('Calendar id (default "primary").'),
  summary: str("Title."),
  start: str("Start: ISO 8601 date-time with offset (or YYYY-MM-DD for all-day)."),
  end: str("End: ISO 8601 date-time with offset (or YYYY-MM-DD, exclusive, for all-day)."),
  timeZone: str("IANA time zone, e.g. Europe/Berlin (optional)."),
  description: str("Description / agenda."),
  location: str("Location."),
  attendees: strList("Attendee e-mail addresses."),
  addMeet: bool("Add a Google Meet link."),
  notifyAttendees: bool("E-mail the attendees about it (default true when there are attendees).")
};

export const calendarActions: ConnectorAction[] = [
  {
    name: "calendar_list_events",
    group: "calendar_read",
    title: "List calendar events",
    effect: "read",
    description: "List events in the user's Google Calendar between two times (recurring events expanded), optionally filtered by text.",
    inputSchema: objectSchema(
      {
        timeMin: dateTime("Start of the window."),
        timeMax: dateTime("End of the window."),
        query: str("Free-text filter (title, description, attendees)."),
        calendarId: str('Calendar id (default "primary").'),
        maxResults: int("Max events (default 25).", 1, 100)
      },
      ["timeMin", "timeMax"]
    ),
    async run(input, ctx) {
      const calendarId = optionalString(input, "calendarId", 300) ?? "primary";
      const items = await ctx.http.paginate<{ items?: GoogleEvent[]; nextPageToken?: string }, GoogleEvent>(
        {
          url: `${api(ctx)}/calendars/${seg(calendarId)}/events`,
          query: {
            timeMin: requireDateTime(input, "timeMin"),
            timeMax: requireDateTime(input, "timeMax"),
            q: optionalString(input, "query", 500),
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 100
          }
        },
        {
          items: (page) => page.items ?? [],
          next: (page) =>
            page.nextPageToken
              ? { url: `${api(ctx)}/calendars/${seg(calendarId)}/events`, query: { timeMin: String(input.timeMin), timeMax: String(input.timeMax), singleEvents: true, orderBy: "startTime", pageToken: page.nextPageToken, q: optionalString(input, "query", 500) } }
              : undefined,
          max: optionalInt(input, "maxResults", 1, 100, 25)
        }
      );
      return { summary: `${items.length} event${items.length === 1 ? "" : "s"}.`, data: { events: items.map(eventView) } };
    }
  },
  {
    name: "calendar_find_free_time",
    group: "calendar_read",
    title: "Find free time",
    effect: "read",
    description:
      "Find open slots of a given length in the user's calendar (and optionally other people's calendars they can see) between two times, within working hours.",
    inputSchema: objectSchema(
      {
        timeMin: dateTime("Start of the search window."),
        timeMax: dateTime("End of the search window (max 31 days later)."),
        durationMinutes: int("Length of the slot needed.", 5, 600),
        attendees: strList("Other people's e-mail addresses to include (their free/busy must be visible)."),
        workdayStartHour: int("Earliest hour (local to timeMin's offset), default 9.", 0, 23),
        workdayEndHour: int("Latest hour (local to timeMin's offset), default 18.", 1, 24)
      },
      ["timeMin", "timeMax", "durationMinutes"]
    ),
    async run(input, ctx) {
      const timeMin = requireDateTime(input, "timeMin");
      const timeMax = requireDateTime(input, "timeMax");
      const from = Date.parse(timeMin);
      const to = Date.parse(timeMax);
      if (to <= from || to - from > 31 * 86400_000) throw new ConnectorError("bad_input", "The window must be positive and at most 31 days.");
      const calendars = ["primary", ...emailList(input, "attendees")];
      const result = await ctx.http.post<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }> }>(`${api(ctx)}/freeBusy`, {
        timeMin,
        timeMax,
        items: calendars.map((id) => ({ id }))
      });
      const busy = Object.values(result.calendars ?? {}).flatMap((c) => (c.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })));
      const unavailable = Object.entries(result.calendars ?? {}).filter(([, c]) => c.errors?.length).map(([id]) => id);
      const offset = offsetOf(timeMin);
      const slots = freeSlots({
        from,
        to,
        busy,
        durationMinutes: optionalInt(input, "durationMinutes", 5, 600, 30),
        workdayStartHour: optionalInt(input, "workdayStartHour", 0, 23, 9),
        workdayEndHour: optionalInt(input, "workdayEndHour", 1, 24, 18),
        utcOffsetMinutes: offset
      });
      return {
        summary: `${slots.length} free slot${slots.length === 1 ? "" : "s"}.`,
        data: { slots: slots.map((s) => ({ start: isoWithOffset(s.start, offset), end: isoWithOffset(s.end, offset) })), calendarsWithoutAccess: unavailable.length ? unavailable : undefined }
      };
    }
  },
  {
    name: "calendar_create_event",
    group: "calendar_write",
    title: "Create a calendar event",
    effect: "write",
    description: "Create an event in the user's Google Calendar, optionally inviting attendees and adding a Meet link.",
    inputSchema: objectSchema(eventFields, ["summary", "start", "end"]),
    async run(input, ctx) {
      const calendarId = optionalString(input, "calendarId", 300) ?? "primary";
      const timeZone = optionalString(input, "timeZone", 64);
      const attendees = emailList(input, "attendees");
      const body = {
        summary: requireString(input, "summary", 500),
        start: timeField(requireString(input, "start", 64), timeZone),
        end: timeField(requireString(input, "end", 64), timeZone),
        ...(optionalString(input, "description", 8000) ? { description: optionalString(input, "description", 8000) } : {}),
        ...(optionalString(input, "location", 500) ? { location: optionalString(input, "location", 500) } : {}),
        ...(attendees.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
        ...(input.addMeet === true ? { conferenceData: { createRequest: { requestId: `sibyl-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {})
      };
      const event = await ctx.http.post<GoogleEvent>(`${api(ctx)}/calendars/${seg(calendarId)}/events`, body, {
        sendUpdates: attendees.length && input.notifyAttendees !== false ? "all" : "none",
        ...(input.addMeet === true ? { conferenceDataVersion: 1 } : {})
      });
      return { summary: "Event created.", data: eventView(event) };
    }
  },
  {
    name: "calendar_update_event",
    group: "calendar_write",
    title: "Update a calendar event",
    effect: "write",
    description: "Change an existing Google Calendar event (only the fields given). Attendees given replace the list.",
    inputSchema: objectSchema({ eventId: str("Event id from calendar_list_events."), ...eventFields }, ["eventId"]),
    async run(input, ctx) {
      const calendarId = optionalString(input, "calendarId", 300) ?? "primary";
      const timeZone = optionalString(input, "timeZone", 64);
      const patch: Record<string, unknown> = {};
      const summaryText = optionalString(input, "summary", 500);
      if (summaryText) patch.summary = summaryText;
      const start = optionalDateTime(input, "start") ?? (typeof input.start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.start) ? input.start : undefined);
      const end = optionalDateTime(input, "end") ?? (typeof input.end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.end) ? input.end : undefined);
      if (start) patch.start = timeField(start, timeZone);
      if (end) patch.end = timeField(end, timeZone);
      const description = optionalString(input, "description", 8000);
      if (description !== undefined) patch.description = description;
      const location = optionalString(input, "location", 500);
      if (location !== undefined) patch.location = location;
      const attendees = input.attendees === undefined ? undefined : emailList(input, "attendees");
      if (attendees) patch.attendees = attendees.map((email) => ({ email }));
      if (Object.keys(patch).length === 0) return "Nothing to change.";
      const event = await ctx.http.patch<GoogleEvent>(`${api(ctx)}/calendars/${seg(calendarId)}/events/${seg(requireId(input, "eventId"))}`, patch, {
        sendUpdates: input.notifyAttendees === false ? "none" : "all"
      });
      return { summary: "Event updated.", data: eventView(event) };
    }
  }
];
