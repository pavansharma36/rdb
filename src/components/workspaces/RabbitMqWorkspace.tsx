import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errString } from "../../api";
import type {
  ConnectionId,
  MqChannel,
  MqConnection,
  MqExchange,
  MqMessage,
  MqOverview,
  MqQueue,
} from "../../api";

interface Props {
  connectionId: ConnectionId;
}

type Tab = "overview" | "queues" | "exchanges" | "connections";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "queues", label: "Queues" },
  { id: "exchanges", label: "Exchanges" },
  { id: "connections", label: "Connections" },
];

const REFRESH_OPTIONS = [
  { label: "Off", ms: 0 },
  { label: "2s", ms: 2000 },
  { label: "5s", ms: 5000 },
  { label: "10s", ms: 10000 },
];

const fmtRate = (r: number | undefined) => `${(r ?? 0).toFixed(1)}/s`;

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** The default vhost "/" displays as "/" but is its own selectable value. */
const vhostLabel = (v: string) => v || "/";

export function RabbitMqWorkspace({ connectionId }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [refreshMs, setRefreshMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [overview, setOverview] = useState<MqOverview | null>(null);
  const [queues, setQueues] = useState<MqQueue[]>([]);
  const [exchanges, setExchanges] = useState<MqExchange[]>([]);
  const [connections, setConnections] = useState<MqConnection[]>([]);
  const [channels, setChannels] = useState<MqChannel[]>([]);

  const load = useCallback(
    async (active: Tab) => {
      setLoading(true);
      setError(null);
      try {
        switch (active) {
          case "overview":
            setOverview(await api.mqOverview(connectionId));
            break;
          case "queues":
            setQueues(await api.mqListQueues(connectionId));
            break;
          case "exchanges":
            setExchanges(await api.mqListExchanges(connectionId));
            break;
          case "connections":
            setConnections(await api.mqListConnections(connectionId));
            setChannels(await api.mqListChannels(connectionId));
            break;
        }
      } catch (e) {
        setError(errString(e));
      } finally {
        setLoading(false);
      }
    },
    [connectionId],
  );

  // Reload whenever the active tab changes.
  useEffect(() => {
    load(tab);
  }, [tab, load]);

  // Auto-refresh the active tab on the chosen interval.
  useEffect(() => {
    if (!refreshMs) return;
    const h = setInterval(() => load(tab), refreshMs);
    return () => clearInterval(h);
  }, [refreshMs, tab, load]);

  return (
    <div className="mq">
      <div className="mq-tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={"mq-tab" + (tab === t.id ? " active" : "")}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <span className="spacer" />
        {loading && <span className="mq-spin">…</span>}
        <label className="mq-refresh">
          refresh
          <select
            value={refreshMs}
            onChange={(e) => setRefreshMs(Number(e.target.value))}
          >
            {REFRESH_OPTIONS.map((o) => (
              <option key={o.ms} value={o.ms}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => load(tab)} disabled={loading}>
          Refresh
        </button>
      </div>

      {error && <div className="status-line error">{error}</div>}

      <div className="mq-body">
        {tab === "overview" && <OverviewTab overview={overview} />}
        {tab === "queues" && (
          <QueuesTab
            connectionId={connectionId}
            queues={queues}
            onChanged={() => load("queues")}
            onError={setError}
          />
        )}
        {tab === "exchanges" && (
          <ExchangesTab
            connectionId={connectionId}
            exchanges={exchanges}
            onError={setError}
          />
        )}
        {tab === "connections" && (
          <ConnectionsTab connections={connections} channels={channels} />
        )}
      </div>
    </div>
  );
}

// --- Sortable table -------------------------------------------------------

interface Col<T> {
  key: string;
  label: string;
  /** Cell renderer. */
  render: (row: T) => React.ReactNode;
  /** Value used for sorting; defaults to no sort on this column. */
  sortVal?: (row: T) => string | number;
  align?: "right";
}

function DataTable<T>({
  cols,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  empty,
}: {
  cols: Col<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  empty: string;
}) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [desc, setDesc] = useState(false);

  const sorted = useMemo(() => {
    const col = cols.find((c) => c.key === sortKey);
    if (!col?.sortVal) return rows;
    const out = [...rows].sort((a, b) => {
      const av = col.sortVal!(a);
      const bv = col.sortVal!(b);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    return desc ? out.reverse() : out;
  }, [rows, cols, sortKey, desc]);

  function clickHeader(c: Col<T>) {
    if (!c.sortVal) return;
    if (sortKey === c.key) setDesc((d) => !d);
    else {
      setSortKey(c.key);
      setDesc(false);
    }
  }

  if (rows.length === 0) return <div className="placeholder">{empty}</div>;

  return (
    <div className="result-scroll">
      <table className="grid">
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c.key}
                onClick={() => clickHeader(c)}
                style={{
                  cursor: c.sortVal ? "pointer" : "default",
                  textAlign: c.align === "right" ? "right" : "left",
                }}
              >
                {c.label}
                {sortKey === c.key ? (desc ? " ▾" : " ▴") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const k = rowKey(row);
            return (
              <tr
                key={k}
                onClick={() => onRowClick?.(row)}
                className={selectedKey === k ? "mq-row-sel" : ""}
                style={{ cursor: onRowClick ? "pointer" : "default" }}
              >
                {cols.map((c) => (
                  <td
                    key={c.key}
                    style={{ textAlign: c.align === "right" ? "right" : "left" }}
                  >
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Overview -------------------------------------------------------------

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="mq-stat">
      <div className="mq-stat-val">{value}</div>
      <div className="mq-stat-label">{label}</div>
    </div>
  );
}

function OverviewTab({ overview: o }: { overview: MqOverview | null }) {
  if (!o) return <div className="placeholder">No data.</div>;
  const t = o.object_totals;
  const q = o.queue_totals;
  const m = o.message_stats;
  return (
    <div className="mq-overview">
      <div className="mq-banner">
        <strong>{o.cluster_name || "RabbitMQ"}</strong>
        <span className="muted">
          node {o.node || "?"} · RabbitMQ {o.rabbitmq_version || "?"} · Erlang{" "}
          {o.erlang_version || "?"}
        </span>
      </div>

      <h3>Queued messages</h3>
      <div className="mq-stats">
        <Stat label="Ready" value={q.messages_ready} />
        <Stat label="Unacked" value={q.messages_unacknowledged} />
        <Stat label="Total" value={q.messages} />
      </div>

      <h3>Message rates</h3>
      <div className="mq-stats">
        <Stat label="Publish" value={fmtRate(m.publish_details?.rate)} />
        <Stat label="Deliver / get" value={fmtRate(m.deliver_get_details?.rate)} />
        <Stat label="Ack" value={fmtRate(m.ack_details?.rate)} />
      </div>

      <h3>Global counts</h3>
      <div className="mq-stats">
        <Stat label="Connections" value={t.connections} />
        <Stat label="Channels" value={t.channels} />
        <Stat label="Exchanges" value={t.exchanges} />
        <Stat label="Queues" value={t.queues} />
        <Stat label="Consumers" value={t.consumers} />
      </div>
    </div>
  );
}

// --- Queues ---------------------------------------------------------------

function QueuesTab({
  connectionId,
  queues,
  onChanged,
  onError,
}: {
  connectionId: ConnectionId;
  queues: MqQueue[];
  onChanged: () => void;
  onError: (e: string | null) => void;
}) {
  const [selected, setSelected] = useState<MqQueue | null>(null);
  const [newName, setNewName] = useState("");
  const [newDurable, setNewDurable] = useState(true);
  const [busy, setBusy] = useState(false);

  // Keep the open detail panel in sync with refreshed data.
  const live = selected
    ? queues.find(
        (q) => q.name === selected.name && q.vhost === selected.vhost,
      ) ?? selected
    : null;

  async function guard(fn: () => Promise<void>) {
    setBusy(true);
    onError(null);
    try {
      await fn();
    } catch (e) {
      onError(errString(e));
    } finally {
      setBusy(false);
    }
  }

  const declare = () =>
    guard(async () => {
      await api.mqDeclareQueue(connectionId, "/", newName.trim(), newDurable);
      setNewName("");
      onChanged();
    });

  const cols: Col<MqQueue>[] = [
    {
      key: "name",
      label: "Name",
      render: (r) => r.name,
      sortVal: (r) => r.name,
    },
    {
      key: "vhost",
      label: "Vhost",
      render: (r) => vhostLabel(r.vhost),
      sortVal: (r) => r.vhost,
    },
    { key: "type", label: "Type", render: (r) => r.type, sortVal: (r) => r.type },
    {
      key: "state",
      label: "State",
      render: (r) => r.state,
      sortVal: (r) => r.state,
    },
    {
      key: "ready",
      label: "Ready",
      align: "right",
      render: (r) => r.messages_ready,
      sortVal: (r) => r.messages_ready,
    },
    {
      key: "unacked",
      label: "Unacked",
      align: "right",
      render: (r) => r.messages_unacknowledged,
      sortVal: (r) => r.messages_unacknowledged,
    },
    {
      key: "total",
      label: "Total",
      align: "right",
      render: (r) => r.messages,
      sortVal: (r) => r.messages,
    },
    {
      key: "consumers",
      label: "Consumers",
      align: "right",
      render: (r) => r.consumers,
      sortVal: (r) => r.consumers,
    },
    {
      key: "incoming",
      label: "Incoming",
      align: "right",
      render: (r) => fmtRate(r.message_stats?.publish_details?.rate),
      sortVal: (r) => r.message_stats?.publish_details?.rate ?? 0,
    },
  ];

  return (
    <div className="mq-split">
      <div className="mq-main">
        <div className="section">
          <h3>Add queue</h3>
          <div className="row">
            <input
              className="grow"
              placeholder="queue name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <label className="row">
              <input
                type="checkbox"
                checked={newDurable}
                onChange={(e) => setNewDurable(e.target.checked)}
              />{" "}
              durable
            </label>
            <button disabled={busy || !newName.trim()} onClick={declare}>
              Declare
            </button>
          </div>
        </div>
        <DataTable
          cols={cols}
          rows={queues}
          rowKey={(r) => r.vhost + "/" + r.name}
          onRowClick={(r) => setSelected(r)}
          selectedKey={live ? live.vhost + "/" + live.name : null}
          empty="No queues."
        />
      </div>
      {live && (
        <QueueDetail
          connectionId={connectionId}
          queue={live}
          busy={busy}
          guard={guard}
          onChanged={onChanged}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function QueueDetail({
  connectionId,
  queue,
  busy,
  guard,
  onChanged,
  onClose,
}: {
  connectionId: ConnectionId;
  queue: MqQueue;
  busy: boolean;
  guard: (fn: () => Promise<void>) => Promise<void>;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [payload, setPayload] = useState("");
  const [count, setCount] = useState(1);
  const [remove, setRemove] = useState(false);
  const [messages, setMessages] = useState<MqMessage[]>([]);

  const publish = () =>
    guard(async () => {
      // Empty exchange + queue name as routing key = default exchange.
      await api.mqPublish(connectionId, queue.vhost, "", queue.name, payload);
    });

  const getMessages = () =>
    guard(async () => {
      const ms = await api.mqGetMessages(
        connectionId,
        queue.vhost,
        queue.name,
        count,
        remove ? "ack_requeue_false" : "ack_requeue_true",
      );
      setMessages(ms);
      if (remove) onChanged();
    });

  const purge = () =>
    guard(async () => {
      await api.mqPurgeQueue(connectionId, queue.vhost, queue.name);
      setMessages([]);
      onChanged();
    });

  const del = () =>
    guard(async () => {
      await api.mqDeleteQueue(connectionId, queue.vhost, queue.name);
      onChanged();
      onClose();
    });

  return (
    <div className="mq-detail">
      <div className="mq-detail-head">
        <strong>{queue.name}</strong>
        <button className="icon-btn" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="muted small">
        vhost {vhostLabel(queue.vhost)} · {queue.type || "classic"} ·{" "}
        {queue.durable ? "durable" : "transient"} · {fmtBytes(queue.memory)}
      </div>
      <div className="mq-stats">
        <Stat label="Ready" value={queue.messages_ready} />
        <Stat label="Unacked" value={queue.messages_unacknowledged} />
        <Stat label="Consumers" value={queue.consumers} />
      </div>

      <div className="section">
        <h3>Publish message</h3>
        <textarea
          className="code"
          placeholder="message payload"
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
        />
        <div className="row">
          <button disabled={busy} onClick={publish}>
            Publish to this queue
          </button>
        </div>
      </div>

      <div className="section">
        <h3>Get messages</h3>
        <div className="row">
          <label className="row">
            count{" "}
            <input
              type="number"
              min={1}
              value={count}
              style={{ width: 70 }}
              onChange={(e) => setCount(Number(e.target.value) || 1)}
            />
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={remove}
              onChange={(e) => setRemove(e.target.checked)}
            />{" "}
            remove from queue
          </label>
          <button disabled={busy} onClick={getMessages}>
            Get
          </button>
        </div>
      </div>

      <div className="row">
        <button disabled={busy} onClick={purge}>
          Purge
        </button>
        <button className="row-del" disabled={busy} onClick={del}>
          Delete queue
        </button>
      </div>

      <div className="msg-list">
        {messages.map((m, i) => (
          <div key={i} className="msg-item">
            <div className="msg-meta">
              {m.payload_bytes} byte(s) · key {m.routing_key || "(none)"}
              {m.redelivered ? " · redelivered" : ""}
            </div>
            {m.payload}
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Exchanges ------------------------------------------------------------

function ExchangesTab({
  connectionId,
  exchanges,
  onError,
}: {
  connectionId: ConnectionId;
  exchanges: MqExchange[];
  onError: (e: string | null) => void;
}) {
  const [selected, setSelected] = useState<MqExchange | null>(null);
  const [routingKey, setRoutingKey] = useState("");
  const [payload, setPayload] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const live = selected
    ? exchanges.find(
        (x) => x.name === selected.name && x.vhost === selected.vhost,
      ) ?? selected
    : null;

  const publish = () =>
    (async () => {
      setBusy(true);
      onError(null);
      setStatus(null);
      try {
        const r = await api.mqPublish(
          connectionId,
          live!.vhost,
          live!.name,
          routingKey,
          payload,
        );
        setStatus(
          r.routed
            ? "Published (routed)."
            : "Published, but not routed to any queue.",
        );
      } catch (e) {
        onError(errString(e));
      } finally {
        setBusy(false);
      }
    })();

  const cols: Col<MqExchange>[] = [
    {
      key: "name",
      label: "Name",
      render: (r) => r.name || "(AMQP default)",
      sortVal: (r) => r.name,
    },
    {
      key: "vhost",
      label: "Vhost",
      render: (r) => vhostLabel(r.vhost),
      sortVal: (r) => r.vhost,
    },
    { key: "type", label: "Type", render: (r) => r.type, sortVal: (r) => r.type },
    {
      key: "durable",
      label: "Durable",
      render: (r) => (r.durable ? "yes" : "no"),
      sortVal: (r) => String(r.durable),
    },
    {
      key: "auto_delete",
      label: "Auto-delete",
      render: (r) => (r.auto_delete ? "yes" : "no"),
    },
    {
      key: "internal",
      label: "Internal",
      render: (r) => (r.internal ? "yes" : "no"),
    },
  ];

  return (
    <div className="mq-split">
      <div className="mq-main">
        <DataTable
          cols={cols}
          rows={exchanges}
          rowKey={(r) => r.vhost + "/" + r.name}
          onRowClick={(r) => {
            setSelected(r);
            setStatus(null);
          }}
          selectedKey={live ? live.vhost + "/" + live.name : null}
          empty="No exchanges."
        />
      </div>
      {live && (
        <div className="mq-detail">
          <div className="mq-detail-head">
            <strong>{live.name || "(AMQP default)"}</strong>
            <button
              className="icon-btn"
              onClick={() => setSelected(null)}
              title="Close"
            >
              ✕
            </button>
          </div>
          <div className="muted small">
            vhost {vhostLabel(live.vhost)} · {live.type}
          </div>
          <div className="section">
            <h3>Publish message</h3>
            <input
              className="grow"
              placeholder="routing key"
              value={routingKey}
              onChange={(e) => setRoutingKey(e.target.value)}
            />
            <textarea
              className="code"
              placeholder="message payload"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
            />
            <div className="row">
              <button disabled={busy} onClick={publish}>
                Publish
              </button>
              {status && <span className="status-line">{status}</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Connections & Channels ----------------------------------------------

function ConnectionsTab({
  connections,
  channels,
}: {
  connections: MqConnection[];
  channels: MqChannel[];
}) {
  const connCols: Col<MqConnection>[] = [
    { key: "name", label: "Name", render: (r) => r.name, sortVal: (r) => r.name },
    { key: "user", label: "User", render: (r) => r.user, sortVal: (r) => r.user },
    {
      key: "vhost",
      label: "Vhost",
      render: (r) => vhostLabel(r.vhost),
      sortVal: (r) => r.vhost,
    },
    {
      key: "state",
      label: "State",
      render: (r) => r.state,
      sortVal: (r) => r.state,
    },
    {
      key: "protocol",
      label: "Protocol",
      render: (r) => r.protocol,
      sortVal: (r) => r.protocol,
    },
    {
      key: "peer",
      label: "Peer",
      render: (r) => `${r.peer_host}:${r.peer_port}`,
    },
    {
      key: "ssl",
      label: "TLS",
      render: (r) => (r.ssl ? "yes" : "no"),
    },
    {
      key: "channels",
      label: "Channels",
      align: "right",
      render: (r) => r.channels,
      sortVal: (r) => r.channels,
    },
  ];

  const chanCols: Col<MqChannel>[] = [
    { key: "name", label: "Name", render: (r) => r.name, sortVal: (r) => r.name },
    { key: "user", label: "User", render: (r) => r.user, sortVal: (r) => r.user },
    {
      key: "vhost",
      label: "Vhost",
      render: (r) => vhostLabel(r.vhost),
      sortVal: (r) => r.vhost,
    },
    {
      key: "state",
      label: "State",
      render: (r) => r.state,
      sortVal: (r) => r.state,
    },
    {
      key: "consumers",
      label: "Consumers",
      align: "right",
      render: (r) => r.consumer_count,
      sortVal: (r) => r.consumer_count,
    },
    {
      key: "unacked",
      label: "Unacked",
      align: "right",
      render: (r) => r.messages_unacknowledged,
      sortVal: (r) => r.messages_unacknowledged,
    },
    {
      key: "prefetch",
      label: "Prefetch",
      align: "right",
      render: (r) => r.prefetch_count,
      sortVal: (r) => r.prefetch_count,
    },
  ];

  return (
    <div className="mq-main">
      <h3>Connections</h3>
      <DataTable
        cols={connCols}
        rows={connections}
        rowKey={(r) => r.name}
        empty="No open connections."
      />
      <h3>Channels</h3>
      <DataTable
        cols={chanCols}
        rows={channels}
        rowKey={(r) => r.name}
        empty="No open channels."
      />
    </div>
  );
}
