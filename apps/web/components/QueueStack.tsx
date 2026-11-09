"use client";

import { Icon } from "./Icon";

export interface QueuedMessage {
  id: string;
  text: string;
}

interface QueueStackProps {
  items: QueuedMessage[];
  busy: boolean;
  onSendNow: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onMoveUp: (id: string) => void;
  onSendTogether: () => void;
  onClear: () => void;
}

/**
 * Messages typed while Sibyl is still answering. They go out one by one when
 * she's free; each can be sent right now (interrupting), edited, reordered or
 * removed, and several can be combined into one message.
 */
export function QueueStack(props: QueueStackProps) {
  if (props.items.length === 0) return null;
  return (
    <section className="queue" aria-label="Queued messages">
      <header className="queueHead">
        <span className="queueTitle">
          <span className="queueCount">{props.items.length}</span>
          {props.items.length === 1 ? "message queued" : "messages queued"}
          <span className="queueHint">
            {props.busy ? "· sends when Sibyl finishes" : "· sending next"}
          </span>
        </span>
        <span className="queueHeadActions">
          {props.items.length > 1 ? (
            <button type="button" className="queueLink" onClick={props.onSendTogether}>
              Send as one
            </button>
          ) : null}
          <button type="button" className="queueLink muted" onClick={props.onClear}>
            Clear
          </button>
        </span>
      </header>
      <ol className="queueList">
        {props.items.map((item, index) => (
          <li key={item.id} className="queueItem">
            <span className="queueIndex">{index + 1}</span>
            <span className="queueText" title={item.text}>
              {item.text}
            </span>
            <span className="queueActions">
              {index > 0 ? (
                <button
                  type="button"
                  className="queueBtn"
                  aria-label="Move up"
                  title="Move up"
                  onClick={() => props.onMoveUp(item.id)}
                >
                  <Icon name="arrowUp" size={14} />
                </button>
              ) : null}
              <button
                type="button"
                className="queueBtn"
                aria-label="Edit"
                title="Edit"
                onClick={() => props.onEdit(item.id)}
              >
                <Icon name="pencil" size={14} />
              </button>
              <button
                type="button"
                className="queueBtn"
                aria-label="Remove"
                title="Remove"
                onClick={() => props.onRemove(item.id)}
              >
                <Icon name="close" size={14} />
              </button>
              <button
                type="button"
                className="queueSend"
                title={props.busy ? "Stop the current reply and send this now" : "Send now"}
                onClick={() => props.onSendNow(item.id)}
              >
                Send now
              </button>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
