// Citations: shared state, where a terminal's text came from, and the text an agent gets.
import { agents, terminals, panes, spaces, shared, setShared, run } from "herdr";

const KEY = "cite.items"; // pending citations, oldest first (shared, so every copy sees them)

export const items = () => {
  const v = shared(KEY);
  return Array.isArray(v) ? v : [];
};
export const setItems = (list) => setShared(KEY, list);

export function addItem(item) {
  setItems([...items(), item]);
}
export function updateItem(id, patch) {
  setItems(items().map((it) => (it.id === id ? { ...it, ...patch } : it)));
}
export function removeItem(id) {
  setItems(items().filter((it) => it.id !== id));
}
export function moveItem(id, by) {
  const list = items();
  const i = list.findIndex((it) => it.id === id), j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  setItems(list);
}

const machineOf = (addr) => (addr.includes("/") ? addr.split("/")[0] : null);
const bare = (addr) => (addr.includes("/") ? addr.split("/").pop() : addr);

// What we know about a terminal now: which agent or program, where it sits, its folder and branch.
export function describe(addr) {
  const term = terminals().find((t) => t.address === addr);
  const agent = agents().find((a) => a.address === addr);
  const pane = panes().find((p) => p.terminal === addr);
  const tab = agent?.tab ?? pane?.tab ?? null;
  const space = spaces().find((s) => s.tabs.some((t) => t.id === tab)) ?? null;
  const program = agent?.program ?? pane?.program ?? term?.program ?? null;
  const cwd = pane?.cwd ?? term?.cwd ?? null;
  return {
    terminal: addr,
    machine: space?.machine ?? machineOf(addr),
    agent: Boolean(agent),
    name: program?.name ?? term?.name ?? addr,
    icon: program?.icon ? { icon: program.icon, tint: program.tint } : null,
    title: agent?.title ?? pane?.title ?? "",
    space: space?.id ?? null,
    space_name: space?.name ?? "",
    tab,
    tab_name: agent?.tab_name ?? space?.tabs.find((t) => t.id === tab)?.name ?? "",
    folder: cwd ? cwd.replace(/\/+$/, "").split("/").pop() || "/" : "",
    branch: pane?.branch ?? null,
  };
}

export const alive = (addr) => terminals().some((t) => t.address === addr && (t.state ?? "live") === "live");

// Terminal copies pad lines and may carry trailing blank lines.
export const clean = (text) => (text ?? "").replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").replace(/^\n+|\n+$/g, "");

export const clock = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// How a citation names its source for a reader on `toMachine` (null: this computer).
// A live terminal address in terminal text is Cmd-clickable in Herdr (it peeks at it),
// and bare addresses mean the reader's own machine, so qualify only across machines.
function where(src, toMachine) {
  const m = src.machine ?? null;
  return m === (toMachine ?? null) ? bare(src.terminal) : m ? `${m}/${bare(src.terminal)}` : src.terminal;
}

export function heading(it, n, toMachine) {
  const s = it.source;
  const place = [s.folder, s.branch ? `(${s.branch})` : ""].filter(Boolean).join(" ");
  return `[${n}] ${s.name} · ${where(s, toMachine)}${place ? ` · ${place}` : ""} · ${clock(it.at)}`;
}

// The block pasted into an agent's input: numbered sources, quoted text, notes.
export function compose(list, toMachine) {
  return list.map((it, i) => {
    const quoted = it.text.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
    return [heading(it, i + 1, toMachine), quoted, it.note ? `Note: ${it.note}` : null].filter(Boolean).join("\n");
  }).join("\n\n") + "\n\n";
}

// Back to where a citation came from, with its lines selected again
// (rows hold until that terminal's history is trimmed or reflowed).
export function jump(it) {
  const s = it.source;
  if (!alive(s.terminal)) return false;
  if (s.space) run("space.select", { id: s.space });
  if (s.tab) run("tab.select", { id: s.tab });
  run("pane.focus", { terminal: s.terminal });
  if (it.sel) {
    const { start, end } = it.sel;
    const top = start.row <= end.row ? start : end, rows = Math.min(Math.abs(end.row - start.row), 400);
    run("terminal.select", { terminal: s.terminal, at: { row: top.row, col: 0 }, mode: "line" });
    for (let i = 0; i < rows; i++) run("terminal.adjust_selection", { terminal: s.terminal, direction: "down" });
    if (!rows) run("terminal.adjust_selection", { terminal: s.terminal, direction: "line_end" });
  }
  return true;
}
