/**
 * Monitors feature ("keep an eye on it").
 *
 * Mount: render <MonitorsScreen /> on the /monitors screen. Optional wiring
 * from the app shell:
 * - agents: the agents the person may run tasks as;
 * - canManage: can("monitors.manage");
 * - liveStatus / liveEvents: from the WebSocket after sending
 *   { type: "monitors.subscribe" } (monitors.status) and the shared
 *   `notification` feed (monitor_fired / monitor_paused → the stored
 *   event); without them the screen polls every 30 s;
 * - onOpenConversation: open a task's result chat.
 * <MonitorEvents /> is the activity feed on its own (e.g. in the inbox).
 */
export { MonitorsScreen, type MonitorsScreenProps } from "./MonitorsScreen";
export { MonitorEvents, type MonitorEventsProps } from "./MonitorEvents";
export { MonitorForm, TestResult, type MonitorFormProps } from "./MonitorForm";
export { createMonitorsApi, withStatus, type MonitorsApi, type MonitorsRequest } from "./api";
export { formToInput, formFromView, emptyForm, type MonitorFormState } from "./form-state";
