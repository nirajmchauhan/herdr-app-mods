// Citations, like quoting a reply in Claude: hold Shift+Cmd and drag over any agent's
// text, add a note, and it joins a numbered list in the right panel (Citations, beside Files and Changes). "Send to"
// pastes the list into another agent's input (no Enter), so you add your question.
// Each source names its terminal address, which Herdr makes Cmd-clickable (peek).
//
// One mod, three roles (props.role):
//   watch    a 0 px block: watches for Shift+Cmd+drag and opens the capture popup
//   panel    the list: the `cite` child of the layout's `panel-body` stack (the tab bar's
//            Citations button comes from mod-patches' tabs-synced)
//   capture  the popup that takes a note (opened by the watch copy)
//
// Shift+Cmd+drag: mods see a terminal's selection but not the keyboard, so the watch copy
// runs a tiny helper (modstate.c, built with cc into .bin/) when a selection starts;
// it waits for the mouse button to come up and names the modifiers held meanwhile.
// Cmd is the trigger (Ctrl+click is a right-click on macOS, so Ctrl+drag opens the menu).
// Shift is Herdr's: agents (Claude Code, Codex) take the mouse, and only a Shift+drag
// selects their text; in a plain terminal Cmd+drag alone works too.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, spaces, focused, run, theme, settings, props, openOverlay, closeOverlay, exec, appHome, checking, nextCommand, notify } from "herdr";
import { items, setItems, addItem, updateItem, removeItem, moveItem, describe, clean, clock, compose, jump, alive } from "./store.js";

const showPanel = () => { run("layout.select", { stack: "panel-body", child: "cite" }); run("layout.show", { id: "panel" }); };
const POLL = 120; // ms between selection checks (reads only; no redraw)
const TRIGGERS = ["cmd"]; // modifiers that turn a drag into a citation

const icon = (p, size, color) =>
  !p?.icon ? null : p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
const mono = () => settings().font_family ?? settings().font ?? "JetBrains Mono";
const sigOf = (f) => (f?.terminal && f.selection ? `${f.terminal}|${JSON.stringify(f.selection)}` : null);
// Pastes the citations into `terminal` (focused, or focused first) and clears the list.
// The clipboard carries them, so put back what it held before.
async function pasteInto(terminal, machine, cx) {
  const list = items();
  if (!list.length) { notify({ title: "No citations to paste", body: "Hold ⇧⌘ and drag over an agent's text to cite it.", timeout: 4000 }); return; }
  const before = cx.read_from_clipboard();
  cx.write_to_clipboard(compose(list, machine));
  if (focused()?.terminal !== terminal) {
    run("pane.focus", { terminal });
    await cx.sleep(120);
    if (focused()?.terminal !== terminal) return; // didn't get there: leave the list alone
  }
  run("terminal.paste");
  setItems([]);
  await cx.sleep(400);
  if (before !== undefined) cx.write_to_clipboard(before);
}
const machineOfSpace = (id) => spaces().find((s) => s.id === id)?.machine ?? null;

const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export default class Cite extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.role = p.role ?? (p.overlay ? "capture" : "panel");
    if (this.role === "status") this.role = "watch"; // its old name
    if (this.role === "watch") this.initWatch(cx);
    if (this.role === "capture") this.initCapture(cx);
  }

  render(cx) {
    if (this.role === "watch") return div();
    if (this.role === "capture") return this.renderCapture();
    return this.renderPanel();
  }

  // ---- watch: Shift+Cmd+drag ----

  initWatch(cx) {
    this.sig = sigOf(focused());
    this.tracking = false;
    this.helper = null;
    if (checking()) return;
    const dir = `${appHome()}/mods/cite`, bin = `${dir}/.bin/modstate`;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", `[ "$1" -nt "$2" ] || { mkdir -p "$(dirname "$1")" && cc -O2 -framework ApplicationServices "$2" -o "$1"; }`, "sh", bin, `${dir}/modstate.c`]);
        if (r.code === 0) this.helper = bin;
        else console.log(`cite: building the modifier helper failed: ${r.stderr}`);
      } catch (e) {
        console.log(`cite: no modifier helper: ${e}`);
      }
    });
    cx.timer.every(POLL, (cx) => this.watch(cx));
    // keys.json: "cmd-shift-'": "cite.paste" pastes them into the focused terminal.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const f = focused();
        if (c === "paste" && f?.terminal) await pasteInto(f.terminal, machineOfSpace(f.space), cx);
      }
    });
  }

  watch(cx) {
    const f = focused();
    const sig = sigOf(f);
    if (sig === this.sig) return;
    this.sig = sig;
    if (!sig || this.tracking || !this.helper) return;
    const term = f.terminal;
    this.tracking = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec(this.helper, ["wait"], { timeout: 125000 });
        const held = r.stdout.trim().split(/\s+/);
        if (!TRIGGERS.some((m) => held.includes(m))) return;
        await cx.sleep(120); // let the drag's last update and copy-on-select land
        const now = focused();
        if (now?.terminal !== term || !now.selection) return;
        run("terminal.copy");
        await cx.sleep(100);
        const text = clean(cx.read_from_clipboard());
        if (!text) return;
        openOverlay({
          mod: "cite", kind: "popup", at: "pointer", width: 460, height: 320,
          props: { role: "capture", draft: { text, sel: now.selection, source: describe(term) } },
        });
      } catch (e) {
        console.log(`cite: watch failed: ${e}`);
      } finally {
        this.tracking = false;
        this.sig = sigOf(focused());
      }
    });
  }

  // ---- capture: the note popup ----

  initCapture(cx) {
    const p = props() ?? {};
    const editing = p.edit ? items().find((it) => it.id === p.edit) : null;
    this.editing = editing;
    this.draft = editing ?? p.draft ?? null;
    this.input = InputState.new({ value: this.draft?.note ?? "", placeholder: "Add a note (optional)" });
    this.input.on("submit", () => this.save());
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  save() {
    const note = this.input.value().trim();
    if (this.editing) updateItem(this.editing.id, { note });
    else if (this.draft) {
      addItem({ id: newId(), at: Date.now(), note, text: this.draft.text, sel: this.draft.sel, source: this.draft.source });
      showPanel();
    }
    closeOverlay(props().overlay);
  }

  renderCapture() {
    const t = theme(), d = this.draft;
    if (!d) return div();
    const s = d.source, lines = d.text.split("\n"), shown = lines.slice(0, 7);
    const button = (id, text, primary, action) => h_flex().id(id).h(30).px(12).items_center().rounded(7)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).cursor_pointer()
      .hover((st) => st.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("capture").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .size_full().p(14).gap(10).bg(t.popover).text_color(t.foreground)
      .child(h_flex().gap(6).items_center()
        .child(svg("mods/cite/quote.svg").size(13).text_color(t.accent))
        .child(div().text_size(13.5).font_semibold().child(this.editing ? "Edit note" : "Cite"))
        .when(Boolean(s.icon), (el) => el.child(icon(s.icon, 14, t.muted)))
        .child(div().flex_1().truncate().text_size(12).text_color(t.muted).child(`${s.name} · ${s.terminal}${s.tab_name ? ` · ${s.tab_name}` : ""}`))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(v_flex().id("snippet").flex_1().min_h(0).overflow_hidden().p(8).rounded(6).bg(t.background).border_1().border_color(t.border)
        .font_family(mono()).text_size(11.5).text_color(t.muted)
        .children(shown.map((l, i) => div().id(`l${i}`).truncate().child(l || " ")))
        .when(lines.length > shown.length, (el) => el.child(div().text_color(t.dim).child(`… ${lines.length - shown.length} more lines`))))
      .child(Input.new(this.input).h(34).px(10).rounded(8).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().gap(8).justify_end()
        .child(button("c-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("c-save", this.editing ? "Save" : "Cite  ⏎", true, () => this.save())));
  }

  // ---- panel: the list and Send to ----

  send(agent, cx) {
    if (!items().length) return;
    run("space.select", { id: agent.space });
    run("tab.select", { id: agent.tab });
    cx.spawn((cx) => pasteInto(agent.address, machineOfSpace(agent.space), cx));
  }

  copyAll(cx) {
    const list = items();
    if (list.length) cx.write_to_clipboard(compose(list, null));
  }

  renderPanel() {
    const t = theme(), list = items();
    const small = (id, label, action, tip) => div().id(id).px(6).h(22).flex().items_center().rounded(5).text_size(11.5).text_color(t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).when(Boolean(tip), (el) => el.tooltip(tip))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(label);

    const card = (it, i) => {
      const s = it.source, lines = it.text.split("\n"), shown = lines.slice(0, 6), live = alive(s.terminal);
      const where = [s.space_name, s.tab_name, s.folder && `${s.folder}${s.branch ? ` (${s.branch})` : ""}`].filter(Boolean).join(" · ");
      return v_flex().id(`it-${it.id}`).p(10).gap(6).rounded(8).bg(t.surface).border_1().border_color(t.border)
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(12).font_semibold().text_color(t.accent).child(`[${i + 1}]`))
          .when(Boolean(s.icon), (el) => el.child(icon(s.icon, 14, t.muted)))
          .child(div().text_size(12.5).font_semibold().truncate().child(s.name))
          .child(div().text_size(11.5).text_color(t.dim).child(s.terminal))
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.dim).child(clock(it.at)))
          .child(small(`up-${it.id}`, "↑", () => moveItem(it.id, -1), "Move up"))
          .child(small(`dn-${it.id}`, "↓", () => moveItem(it.id, 1), "Move down"))
          .child(small(`rm-${it.id}`, "×", () => removeItem(it.id), "Remove")))
        .when(Boolean(where), (el) => el.child(div().text_size(11).text_color(t.dim).truncate().child(where)))
        .child(v_flex().id(`sn-${it.id}`).p(8).rounded(6).bg(t.background).border_1().border_color(t.border)
          .font_family(mono()).text_size(11.5).text_color(t.muted)
          .when(live, (el) => el.cursor_pointer().hover((st) => st.border_color(t.accent)).tooltip("Show it in its terminal"))
          .on_click(() => jump(it))
          .children(shown.map((l, k) => div().id(`sn-${it.id}-${k}`).truncate().child(l || " ")))
          .when(lines.length > shown.length, (el) => el.child(div().text_color(t.dim).child(`… ${lines.length - shown.length} more lines`))))
        .child(h_flex().id(`note-${it.id}`).gap(6).items_start().cursor_pointer()
          .on_click(() => openOverlay({ mod: "cite", kind: "popup", at: "pointer", width: 460, height: 320, props: { role: "capture", edit: it.id } }))
          .child(div().flex_1().text_size(12.5).text_color(it.note ? t.foreground : t.dim).child(it.note || "Add a note…")));
    };

    const targets = agents();
    const target = (a) => h_flex().id(`to-${a.address}`).h(28).px(8).gap(7).items_center().rounded(6)
      .when(list.length > 0, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.send(a, cx)))
      .when(!list.length, (el) => el.opacity(0.45))
      .child(div().size(7).rounded(4).flex_none().bg(t[a.status] ?? t.unknown))
      .child(icon(a.program, 14, t.muted) ?? div())
      .child(div().text_size(12.5).truncate().child(a.program?.name ?? a.address))
      .child(div().flex_1().text_size(11.5).text_color(t.dim).truncate().child(`${a.address} · ${a.tab_name || a.space_name}`));

    return v_flex().id("root").size_full().bg(t.background).rounded(10).border_1().border_color(t.border).overflow_hidden().text_color(t.foreground)
      .child(h_flex().h(40).flex_none().px(12).gap(7).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/cite/quote.svg").size(14).text_color(t.accent))
        .child(div().text_size(13).font_semibold().child("Citations"))
        .when(list.length > 0, (el) => el.child(div().px(6).rounded(8).bg(t.raised).text_size(11).text_color(t.muted).child(String(list.length))))
        .child(div().flex_1())
        .when(list.length > 0, (el) => el
          .child(small("copy", "Copy", (cx) => this.copyAll(cx), "Copy them as text"))
          .child(small("clear", "Clear", () => setItems([]))))
        .child(small("close", "×", () => run("layout.hide", { id: "panel" }), "Hide")))
      .child(list.length
        ? v_flex().id("list").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(8).children(list.map(card))
        : v_flex().flex_1().p(18).gap(8).text_size(12.5).text_color(t.muted)
            .child(div().child("Hold ⇧⌘ and drag over any agent's text to cite it. ⌘⇧' pastes them into the focused terminal."))
            .child(div().text_color(t.dim).child("Citations collect here, numbered. Send them to any agent and they land in its input, quoted with their source, ready for your question.")))
      .child(v_flex().flex_none().p(8).gap(2).border_t(1).border_color(t.border)
        .child(div().px(8).pb(4).text_size(11).text_color(t.dim).child(list.length ? "Send to" : "Send to (cite something first)"))
        .child(v_flex().id("targets").max_h(200).overflow_y_scrollbar().children(
          targets.length ? targets.map(target) : [div().px(8).text_size(12).text_color(t.dim).child("No agents running")])));
  }
}
