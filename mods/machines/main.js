// CPU and memory for this computer and every machine in `hc machine ls`: a gauge
// for each, CPU's recent history as a sparkline.
// Each machine is sampled on its own loop (one `exec` at a time per machine),
// so a slow or unreachable machine never holds up the others.
//
// Props (all optional):
//   compact  true: one status-bar line instead of the sidebar list.
//   block    this copy's layout block id (default "machines"). The copy sizes its
//            own block (a layout block can't size to its content): the line's width,
//            or the list's height.
//   show     "several": only while there is more than one machine;
//            "one": only while this computer is the only one.
//            Otherwise the copy shrinks its block to 0 px and samples nothing, so one
//            layout can hold both a sidebar list and a status-bar line. (Not
//            layout.hide: a hidden block's mod never starts, so it couldn't come back.)
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, hc, props, run, theme } from "herdr";

const EVERY = 3000; // ms between samples of a reachable machine
const RETRY = 30000; // ms before trying a machine that failed again
const HISTORY = 16; // CPU samples kept for the sparkline
const WARN = 85; // percent at which a gauge turns to the "blocked" color
const W = 36; // px for the sparkline and the memory bar
const PAD = 8; // px each side of the status-bar line
const HEADER = 26, ROW = 22, FOOT = 6; // px of the sidebar list

// macOS: top measures CPU over a second; vm_stat + hw.memsize give memory.
const MAC = "top -l 2 -n 0 -s 1 | grep 'CPU usage' | tail -1; vm_stat; sysctl -n hw.memsize";
// Linux: cumulative CPU ticks (deltas are taken between samples) and meminfo.
const LINUX = "head -1 /proc/stat; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo";

function parseMac(out) {
  const idle = Number(/([\d.]+)% idle/.exec(out)?.[1]);
  const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 16384);
  const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
  const total = Number(out.trim().split("\n").pop());
  // Activity Monitor's "Memory Used": app memory + wired + compressed.
  const used = (pages("Anonymous pages") - pages("Pages purgeable") + pages("Pages wired down") + pages("Pages occupied by compressor")) * page;
  return { cpu: Number.isFinite(idle) ? 100 - idle : null, used, total };
}

function parseLinux(out, prev) {
  const ticks = (/^cpu\s+(.*)$/m.exec(out)?.[1] ?? "").trim().split(/\s+/).map(Number).slice(0, 8);
  const busyTotal = ticks.reduce((a, b) => a + b, 0);
  const idle = (ticks[3] ?? 0) + (ticks[4] ?? 0);
  const kb = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(out)?.[1] ?? 0) * 1024;
  const total = kb("MemTotal");
  let cpu = null;
  if (prev && busyTotal > prev.total) cpu = 100 * (1 - (idle - prev.idle) / (busyTotal - prev.total));
  return { cpu, used: total - kb("MemAvailable"), total, ticks: { total: busyTotal, idle } };
}

const gib = (bytes) => `${(bytes / 2 ** 30).toFixed(bytes >= 10 * 2 ** 30 ? 0 : 1)}G`;
const pct = (v) => (v == null ? "–" : `${Math.round(v)}%`);
const memPct = (h) => (h.total ? (100 * h.used) / h.total : null);
const tooltip = (h) =>
  h.error ? `${h.name}: ${h.error}` : `${h.name} · CPU ${pct(h.cpu)} · memory ${h.total ? `${gib(h.used)} of ${gib(h.total)}` : "–"}`;

export default class MachineLoad extends View {
  init(_props, cx) {
    this.hosts = new Map(); // key ("" = this computer) -> { name, os, ticks, cpu, used, total, history, error, busy, next }
    this.visible = null; // unknown until the first machine list
    this.size = null; // the block's current px along its row or column
    this.refreshMachines(cx);
    cx.timer.every(15000, (cx) => this.refreshMachines(cx));
    cx.timer.every(1000, (cx) => this.tick(cx));
  }

  blockId() {
    return props()?.block ?? "machines";
  }

  // Membership and visibility change only on a list that was read: a failed read
  // keeps what we had (it must not drop machines or move the panel), and an answer
  // to an older request is dropped once a newer one has started.
  refreshMachines(cx) {
    const request = (this.request = (this.request ?? 0) + 1);
    cx.spawn(async (cx) => {
      let names = null;
      try {
        const r = await hc(["machine", "ls", "--json"]);
        const list = r.code === 0 ? JSON.parse(r.stdout).machines : null;
        if (Array.isArray(list)) names = list.filter((m) => !m.temporary).map((m) => m.name);
      } catch {}
      if (names == null || request !== this.request) return;
      const keep = new Set(["", ...names]);
      for (const key of keep) if (!this.hosts.has(key)) this.hosts.set(key, { name: key || "This Mac", history: [], next: 0 });
      for (const key of [...this.hosts.keys()]) if (!keep.has(key)) this.hosts.delete(key);
      const show = props()?.show;
      const several = this.hosts.size > 1;
      this.visible = show === "several" ? several : show === "one" ? !several : true;
      this.fit();
      cx.notify();
    });
  }

  // The block's px: 0 while this copy shouldn't show; else the line's width or
  // the list's height. Compared with the block's actual size, so a layout reload
  // or a size restored from an earlier session is corrected too.
  fit() {
    if (this.visible == null || this.size == null) return;
    let want = 0;
    if (this.visible) {
      if (props()?.compact) {
        if (this.items == null) return;
        want = Math.ceil(this.items) + 2 * PAD;
      } else {
        want = HEADER + this.hosts.size * ROW + FOOT;
      }
    }
    if (Math.abs(want - this.size) > 1 && want !== this.asked) {
      this.asked = want;
      run("layout.resize", { id: this.blockId(), px: want });
    }
  }

  tick(cx) {
    if (!this.visible) return;
    const now = Date.now();
    for (const [key, h] of this.hosts) {
      if (h.busy || now < h.next) continue;
      h.busy = true;
      cx.spawn(async (cx) => {
        try {
          await this.sample(key, h);
          h.error = null;
          h.next = Date.now() + EVERY;
        } catch (e) {
          h.error = String(e?.message ?? e).split("\n")[0];
          h.next = Date.now() + RETRY;
        }
        h.busy = false;
        cx.notify();
      });
    }
  }

  async sample(key, h) {
    const on = key || undefined;
    if (!h.os) {
      const r = await exec("uname", ["-s"], { on, timeout: 10000 });
      h.os = r.stdout.trim() || "Linux";
    }
    const r = await exec("sh", ["-c", h.os === "Darwin" ? MAC : LINUX], { on, timeout: 10000 });
    if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
    const s = h.os === "Darwin" ? parseMac(r.stdout) : parseLinux(r.stdout, h.ticks);
    if (s.ticks) h.ticks = s.ticks;
    if (s.cpu != null) {
      h.cpu = Math.max(0, Math.min(100, s.cpu));
      h.history = [...h.history, h.cpu].slice(-HISTORY);
    }
    h.used = s.used;
    h.total = s.total;
  }

  render() {
    const t = theme();
    const color = (v) => (v != null && v >= WARN ? t.blocked : t.accent);
    const value = (v) => div().w(28).flex_none().text_right().text_color(v != null && v >= WARN ? t.blocked : t.muted).child(pct(v));
    const pair = (gauge, v) => h_flex().gap(4).items_center().flex_none().child(gauge).child(value(v));
    const gauges = {
      // CPU's recent history as a sparkline, then the latest %.
      cpu: (h) => pair(
        h_flex().h(12).w(W).items_end().flex_none().overflow_hidden().children(
          h.history.slice(-W / 3).map((v, i) =>
            div().id(`s${i}`).w(2).mr(1).flex_none().h(Math.max(2, Math.round((v / 100) * 12))).rounded(1).bg(color(v)))),
        h.cpu),
      // Memory used as a bar, then the %.
      mem: (h) => {
        const v = memPct(h);
        return pair(
          div().w(W).h(5).flex_none().rounded(3).bg(t.border)
            .child(div().h(5).rounded(3).bg(color(v)).w(Math.round(((v ?? 0) / 100) * W))),
          v);
      },
    };
    return props()?.compact ? this.renderLine(t, gauges) : this.renderList(t, gauges);
  }

  // Sidebar: one row per machine (name, CPU, MEM); the column labels sit in the
  // header so narrow sidebars keep room for names.
  renderList(t, { cpu, mem }) {
    const label = (text) => div().w(68).flex_none().child(text);
    const row = ([key, h]) =>
      h_flex().id(`load-${key || "local"}`).h(ROW).px(8).gap(8).items_center().rounded(6).text_size(11)
        .hover((s) => s.bg(t.hover)).tooltip(tooltip(h))
        .child(div().flex_1().min_w(40).truncate().text_size(11.5).text_color(h.error ? t.dim : t.foreground).child(h.name))
        .when(Boolean(h.error), (el) => el.child(div().flex_none().text_color(t.dim).child("unreachable")))
        .when(!h.error, (el) => el.child(cpu(h)).child(mem(h)));
    return v_flex().id("root").size_full().bg(t.chrome).overflow_y_scrollbar()
      .on_size_change((size, _cx) => { this.size = size.height; this.asked = null; this.fit(); })
      .child(h_flex().h(HEADER).flex_none().px(16).gap(8).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(40).text_size(11.5).child("Machines"))
        .child(label("CPU")).child(label("MEM")))
      .child(v_flex().px(8).pb(FOOT).children([...this.hosts].map(row)));
  }

  // Status bar: "CPU ▂▃▅ 12%  MEM ▬▬ 54%" per machine, with names only when
  // there is more than one.
  renderLine(t, { cpu, mem }) {
    const named = this.hosts.size > 1;
    const tag = (text) => div().flex_none().text_color(t.dim).child(text);
    const labelled = (text, gauge) => h_flex().gap(4).items_center().flex_none().child(tag(text)).child(gauge);
    const item = ([key, h]) =>
      h_flex().id(`load-${key || "local"}`).gap(8).items_center().flex_none().rounded(5).px(4)
        .hover((s) => s.bg(t.hover)).tooltip(tooltip(h))
        .when(named, (el) => el.child(div().flex_none().text_color(h.error ? t.dim : t.foreground).child(h.name)))
        .when(Boolean(h.error), (el) => el.child(tag("unreachable")))
        .when(!h.error, (el) => el.child(labelled("CPU", cpu(h))).child(labelled("MEM", mem(h))));
    return h_flex().id("root").size_full().px(PAD).items_center().justify_end().bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(11).text_color(t.muted)
      .on_size_change((size, _cx) => { this.size = size.width; this.asked = null; this.fit(); })
      .child(h_flex().id("items").flex_none().gap(14).items_center()
        .on_size_change((size, _cx) => { this.items = size.width; this.fit(); })
        .children([...this.hosts].map(item)));
  }
}
