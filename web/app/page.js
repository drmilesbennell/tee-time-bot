"use client";

import { useEffect, useState, useCallback } from "react";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function timeOptions() {
  const opts = [];
  for (let h = 6; h <= 15; h++) {
    for (const m of [0, 30]) {
      const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const h12 = h % 12 === 0 ? 12 : h % 12;
      opts.push({ value, label: `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}` });
    }
  }
  return opts;
}
const TIME_OPTS = timeOptions();

const label = (v) => TIME_OPTS.find((o) => o.value === v)?.label ?? v;

export default function Page() {
  const [pin, setPin] = useState("");
  const [pinInput, setPinInput] = useState("");
  const [cfg, setCfg] = useState(null);
  const [runs, setRuns] = useState([]);
  const [msg, setMsg] = useState({ text: "", good: true });
  const [busy, setBusy] = useState(false);

  const api = useCallback(
    async (path, init = {}) => {
      const res = await fetch(path, {
        ...init,
        headers: { "content-type": "application/json", "x-pin": pin, ...init.headers },
      });
      if (res.status === 401) {
        setPin("");
        localStorage.removeItem("pin");
        throw new Error("Wrong password");
      }
      if (!res.ok) throw new Error("Something went wrong — try again");
      return res.json();
    },
    [pin]
  );

  useEffect(() => {
    const saved = localStorage.getItem("pin");
    if (saved) setPin(saved);
  }, []);

  useEffect(() => {
    if (!pin) return;
    (async () => {
      try {
        setCfg(await api("/api/config"));
        localStorage.setItem("pin", pin);
        setRuns((await api("/api/runs")).runs);
      } catch (e) {
        setMsg({ text: e.message, good: false });
      }
    })();
  }, [pin, api]);

  if (!pin) {
    return (
      <main>
        <div className="pin">
          <h1>⛳ New Seabury Tee Times</h1>
          <p className="subtitle">Enter the family password</p>
          <input
            type="password"
            autoFocus
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setPin(pinInput)}
          />
          <button className="big save" onClick={() => setPin(pinInput)}>
            Open
          </button>
          <p className={`msg ${msg.good ? "good" : "bad"}`}>{msg.text}</p>
        </div>
      </main>
    );
  }

  if (!cfg) return <main><p style={{ marginTop: 60, textAlign: "center" }}>Loading…</p></main>;

  const setPlayer = (i, v) => {
    const players = [...(cfg.players ?? [])];
    while (players.length < 4) players.push("");
    players[i] = v;
    setCfg({ ...cfg, players });
  };

  const toggleDay = (d) =>
    setCfg({
      ...cfg,
      daysOfWeek: cfg.daysOfWeek.includes(d)
        ? cfg.daysOfWeek.filter((x) => x !== d)
        : [...cfg.daysOfWeek, d],
    });

  const save = async () => {
    setBusy(true);
    setMsg({ text: "", good: true });
    try {
      await api("/api/config", { method: "POST", body: JSON.stringify(cfg) });
      setMsg({ text: "Saved ✓", good: true });
    } catch (e) {
      setMsg({ text: e.message, good: false });
    } finally {
      setBusy(false);
    }
  };

  const runTest = async (mode) => {
    if (mode === "book-now") {
      const ok = confirm(
        "This will book a REAL tee time right now (the best open time matching your settings).\n\n" +
          "Only do this as a test — and cancel the booking afterward. Cancellations are free up to a day before.\n\nGo ahead?"
      );
      if (!ok) return;
    }
    setBusy(true);
    setMsg({ text: "", good: true });
    try {
      await api("/api/test", { method: "POST", body: JSON.stringify({ mode }) });
      setMsg({
        text: mode === "book-now" ? "Booking test started — watch your phone!" : "Practice run started — results appear below in a couple of minutes",
        good: true,
      });
      setTimeout(() => {
        api("/api/runs").then((d) => setRuns(d.runs)).catch(() => {});
      }, 15000);
    } catch (e) {
      setMsg({ text: e.message, good: false });
    } finally {
      setBusy(false);
    }
  };

  const players = [...(cfg.players ?? [])];
  while (players.length < 4) players.push("");

  return (
    <main>
      <h1>⛳ New Seabury Tee Times</h1>
      <p className="subtitle">
        Books your foursome the moment times open — two weeks ahead, 7:00 AM sharp.
      </p>

      <section>
        <div className="master">
          <div>
            <div className="state">{cfg.enabled ? "ON" : "OFF"}</div>
            <div className="hint" style={{ marginTop: 2 }}>
              {cfg.enabled ? "Booking automatically on your days" : "Not booking anything"}
            </div>
          </div>
          <button
            className={`switch ${cfg.enabled ? "on" : "off"}`}
            aria-label="On/off switch"
            onClick={() => setCfg({ ...cfg, enabled: !cfg.enabled })}
          >
            <span className="knob" />
          </button>
        </div>
      </section>

      <section>
        <h2>Days you want to play</h2>
        <div className="days">
          {DAYS.map((d) => (
            <button
              key={d}
              className={`day ${cfg.daysOfWeek.includes(d) ? "picked" : ""}`}
              onClick={() => toggleDay(d)}
            >
              {d}
            </button>
          ))}
        </div>
        <p className="hint">A Saturday tee time gets booked on the Saturday two weeks before, at 7 AM.</p>
      </section>

      <section>
        <h2>Tee off between</h2>
        <div className="times">
          <select value={cfg.window.start} onChange={(e) => setCfg({ ...cfg, window: { ...cfg.window, start: e.target.value } })}>
            {TIME_OPTS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <span>and</span>
          <select value={cfg.window.end} onChange={(e) => setCfg({ ...cfg, window: { ...cfg.window, end: e.target.value } })}>
            {TIME_OPTS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <p className="hint">It grabs the earliest open time in this range — currently {label(cfg.window.start)} to {label(cfg.window.end)}.</p>
      </section>

      <section className="players">
        <h2>Who&apos;s playing</h2>
        {players.slice(0, 4).map((p, i) => (
          <input
            key={i}
            value={p}
            placeholder={i === 0 ? "Niccoli, Joseph" : "Last name, First name"}
            onChange={(e) => setPlayer(i, e.target.value)}
          />
        ))}
        <p className="hint">
          Names exactly as they appear in the club directory (last name first). All names go in
          automatically the second the time is booked. Leave boxes empty for a smaller group.
        </p>
      </section>

      <button className="big save" disabled={busy} onClick={save}>
        Save
      </button>
      <p className={`msg ${msg.good ? "good" : "bad"}`}>{msg.text}</p>

      <section>
        <h2>Try it out</h2>
        <button className="big test" disabled={busy} onClick={() => runTest("dry-run")}>
          🔍 Practice run — books nothing
        </button>
        <button className="big danger" disabled={busy} onClick={() => runTest("book-now")}>
          ⛳ Book a real time now (test — cancel it after)
        </button>
        <p className="hint">
          The practice run logs in and shows which times it would grab. The real test actually books
          the best open time matching your settings — cancel it afterward in ForeTees (free until the
          day before).
        </p>
      </section>

      <section>
        <h2>Recent activity</h2>
        {runs.length === 0 ? (
          <p className="hint">Nothing yet.</p>
        ) : (
          <ul className="runs">
            {runs.map((r) => (
              <li key={r.id}>
                <span>
                  {r.status !== "completed" ? "⏳" : r.conclusion === "success" ? "✅" : "❌"}{" "}
                  {r.event === "workflow_dispatch" ? "Test" : "Morning run"}
                </span>
                <span className="when">
                  {new Date(r.startedAt).toLocaleString("en-US", {
                    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                    timeZone: "America/New_York",
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="hint">✅ means done (booked, or nothing to do that day). ❌ means it couldn&apos;t get a time — check your phone for the details.</p>
      </section>
    </main>
  );
}
