import { useState } from "react";
import { api, errString } from "../../api";
import type { ConnectionId, QueueInfo, ConsumedMessage } from "../../api";

interface Props {
  connectionId: ConnectionId;
}

export function MessagingWorkspace({ connectionId }: Props) {
  const [queue, setQueue] = useState("");
  const [info, setInfo] = useState<QueueInfo | null>(null);
  const [body, setBody] = useState("");
  const [ack, setAck] = useState(true);
  const [count, setCount] = useState(1);
  const [messages, setMessages] = useState<ConsumedMessage[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function guard(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await fn();
    } catch (e) {
      setError(errString(e));
    } finally {
      setBusy(false);
    }
  }

  const declare = () =>
    guard(async () => {
      const i = await api.mqDeclareQueue(connectionId, queue);
      setInfo(i);
      setStatus(`Declared "${i.name}".`);
    });

  const publish = () =>
    guard(async () => {
      const r = await api.mqPublish(connectionId, queue, body);
      setStatus(`Published ${r.bytes} byte(s) to "${r.queue}".`);
    });

  const getOne = () =>
    guard(async () => {
      const m = await api.mqGetOne(connectionId, queue, ack);
      if (m) {
        setMessages((ms) => [m, ...ms]);
        setStatus("Got 1 message.");
      } else {
        setStatus("Queue empty.");
      }
    });

  const consume = () =>
    guard(async () => {
      const ms = await api.mqConsumeN(connectionId, queue, count);
      setMessages((cur) => [...ms, ...cur]);
      setStatus(`Consumed ${ms.length} message(s).`);
    });

  return (
    <div className="editor-pane">
      <div className="section">
        <h3>Queue</h3>
        <div className="row">
          <input
            className="grow"
            placeholder="queue name"
            value={queue}
            onChange={(e) => setQueue(e.target.value)}
          />
          <button disabled={busy || !queue} onClick={declare}>
            Declare
          </button>
        </div>
        {info && (
          <span className="status-line">
            {info.message_count} message(s), {info.consumer_count} consumer(s)
          </span>
        )}
      </div>

      <div className="section">
        <h3>Publish</h3>
        <textarea
          className="code"
          placeholder="message body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="row">
          <button disabled={busy || !queue} onClick={publish}>
            Publish
          </button>
        </div>
      </div>

      <div className="section">
        <h3>Consume</h3>
        <div className="row">
          <label className="row">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />{" "}
            ack
          </label>
          <button disabled={busy || !queue} onClick={getOne}>
            Get one
          </button>
          <label className="row">
            N{" "}
            <input
              type="number"
              min={1}
              value={count}
              style={{ width: 70 }}
              onChange={(e) => setCount(Number(e.target.value) || 1)}
            />
          </label>
          <button disabled={busy || !queue} onClick={consume}>
            Consume N
          </button>
        </div>
      </div>

      {status && <div className="status-line">{status}</div>}
      {error && <div className="status-line error">{error}</div>}

      <div className="msg-list">
        {messages.map((m, i) => (
          <div key={i} className="msg-item">
            <div className="msg-meta">
              tag {m.delivery_tag}
              {m.redelivered ? " · redelivered" : ""}
            </div>
            {m.body}
          </div>
        ))}
      </div>
    </div>
  );
}
