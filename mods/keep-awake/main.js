// The cup in the status bar, like the Caffeine menu-bar app:
// click to keep this Mac and its display awake, click again to let them sleep.
// It runs `caffeinate -di -w <Herdr's pid>` as a herdr-core terminal named
// "keep-awake" (no Herdr labels, so it shows in no tab), so the hold ends by
// itself when Herdr quits, and a restarted Herdr finds a hold that is still on.
import { View, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, hc, theme } from "herdr";

const NAME = "keep-awake";

export default class KeepAwake extends View {
  init(_props, cx) {
    this.on = false;
    this.busy = true;
    cx.spawn(async (cx) => {
      this.on = await this.running();
      this.busy = false;
      cx.notify();
    });
    // Someone may end it from outside (hc kill keep-awake): look now and then.
    cx.timer.every(30000, (cx) => cx.spawn(async (cx) => {
      if (this.busy) return;
      const on = await this.running();
      if (on !== this.on) { this.on = on; cx.notify(); }
    }));
  }

  async running() {
    try {
      const r = await hc(["ls", "--json"]);
      return (JSON.parse(r.stdout).terminals ?? []).some((t) => t.name === NAME && t.state === "live");
    } catch {
      return false;
    }
  }

  toggle(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (this.on) {
          await hc(["kill", NAME]);
        } else {
          const pid = (await exec("pgrep", ["-x", "Herdr"])).stdout.trim().split("\n")[0];
          const argv = ["caffeinate", "-di", ...(pid ? ["-w", pid] : [])];
          await hc(["run", "--bg", "--no-parent", "--rm", "--name", NAME, "--", ...argv]);
        }
      } catch {}
      this.on = await this.running();
      this.busy = false;
      cx.notify();
    });
  }

  render() {
    const t = theme();
    return h_flex().id("root").size_full().items_center().justify_center().bg(t.chrome).border_t(1).border_color(t.border)
      .child(h_flex().id("cup").size(22).rounded(5).items_center().justify_center()
        .hover((s) => s.bg(t.hover))
        .tooltip(this.on ? "Keeping this Mac and its display awake. Click to allow sleep." : "Click to keep this Mac and its display awake")
        .on_click((_e, cx) => this.toggle(cx))
        .child(svg("mods/keep-awake/cup.svg").size(14).text_color(this.on ? t.accent : this.busy ? t.dim : t.muted)));
  }
}
