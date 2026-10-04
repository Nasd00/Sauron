import type { EvacSnapshot, Participant, TranscriptEntry } from "@tempmhacks/shared/evac";
import { clock, escapeHtml, initials, linkify } from "./format.js";

export type PhoneOptions = {
  label: string;
  role: Participant["role"];
  send(participantId: string, text: string): Promise<void>;
};

const DEMO_RESIDENT_MESSAGE = "We’re three people. My dad uses a wheelchair, and we don’t have a car.";

/** A phone-style chat for one participant, driven entirely by agent snapshots. */
export class PhoneView {
  readonly element: HTMLElement;
  #snapshot?: EvacSnapshot;
  #selectedId?: string;
  #renderedKey = "";
  #seen = new Map<string, number>();
  #typing = new Set<string>();
  #pinnedUntil = 0;
  readonly #thread: HTMLElement;
  readonly #head: HTMLElement;
  readonly #tabs: HTMLElement;
  readonly #typingRow: HTMLElement;
  readonly #quick: HTMLElement;
  readonly #form: HTMLFormElement;
  readonly #input: HTMLInputElement;
  readonly #note: HTMLElement;

  constructor(readonly options: PhoneOptions) {
    this.element = document.createElement("section");
    this.element.className = `phone phone-${options.role}`;
    this.element.setAttribute("aria-label", options.label);
    this.element.innerHTML = `
      <div class="phone-notch" aria-hidden="true"></div>
      <div class="phone-tabs" role="tablist" aria-label="Choose helper"></div>
      <header class="phone-head"></header>
      <div class="phone-thread" role="log" aria-live="polite" aria-relevant="additions" tabindex="0"></div>
      <div class="typing-row" hidden><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="sr-only">Agent is typing</span></div>
      <div class="quick-replies" aria-label="Suggested replies"></div>
      <p class="phone-note" hidden></p>
      <form class="composer">
        <input type="text" maxlength="1000" autocomplete="off" />
        <button type="submit" aria-label="Send message"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h13M12 5l7 7-7 7" /></svg></button>
      </form>`;
    const pick = <T extends Element>(selector: string) => this.element.querySelector<T>(selector)!;
    this.#thread = pick(".phone-thread");
    this.#head = pick(".phone-head");
    this.#tabs = pick(".phone-tabs");
    this.#typingRow = pick(".typing-row");
    this.#quick = pick(".quick-replies");
    this.#form = pick("form");
    this.#input = pick("input");
    this.#note = pick(".phone-note");
    if (options.role !== "helper") this.#tabs.remove();

    this.#form.addEventListener("submit", event => {
      event.preventDefault();
      void this.#submit(this.#input.value);
    });
    this.#quick.addEventListener("click", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("button[data-reply]");
      if (button) void this.#submit(button.dataset.reply!);
    });
    this.#tabs.addEventListener("click", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("button[data-participant]");
      if (!button) return;
      this.#selectedId = button.dataset.participant;
      this.#pinnedUntil = Date.now() + 30_000;
      this.render();
    });
  }

  update(snapshot: EvacSnapshot): void {
    this.#snapshot = snapshot;
    const candidates = this.#participants();
    if (!this.#selectedId || !candidates.some(p => p.id === this.#selectedId)) this.#selectedId = candidates[0]?.id;
    // Follow the helper the agent most recently messaged, unless the operator just picked a tab.
    if (this.options.role === "helper" && Date.now() > this.#pinnedUntil) {
      const latest = [...snapshot.transcript].reverse().find(entry => candidates.some(p => p.id === entry.participantId));
      if (latest) this.#selectedId = latest.participantId;
    }
    this.render();
  }

  setTyping(participantId: string, typing: boolean): void {
    if (typing) this.#typing.add(participantId); else this.#typing.delete(participantId);
    this.#typingRow.hidden = !(this.#selectedId && this.#typing.has(this.#selectedId));
    if (!this.#typingRow.hidden) this.#scrollToEnd();
  }

  #participants(): Participant[] {
    return (this.#snapshot?.participants ?? []).filter(p => p.role === this.options.role);
  }

  render(): void {
    const snapshot = this.#snapshot;
    const participant = this.#participants().find(p => p.id === this.#selectedId);
    if (!snapshot || !participant) return;
    const entries = snapshot.transcript.filter(entry => entry.participantId === participant.id);
    this.#seen.set(participant.id, entries.length);
    const onIMessage = participant.channel.platform !== "web_sim";
    const helper = snapshot.helpers.find(h => h.participantId === participant.id);

    if (this.options.role === "helper") {
      this.#tabs.innerHTML = this.#participants().map(p => {
        const count = snapshot.transcript.filter(entry => entry.participantId === p.id).length;
        const unread = Math.max(0, count - (this.#seen.get(p.id) ?? 0));
        const selected = p.id === participant.id;
        return `<button type="button" role="tab" aria-selected="${selected}" data-participant="${p.id}">${escapeHtml(p.name.split(" ")[0]!)}${unread ? `<span class="unread" aria-label="${unread} new">${unread}</span>` : ""}</button>`;
      }).join("");
    }

    const subtitle = this.options.role === "resident"
      ? "Resident"
      : `Volunteer driver · ${helper?.vehicle.description ?? ""}`;
    this.#head.innerHTML = `
      <span class="avatar avatar-${this.options.role}" aria-hidden="true">${initials(participant.name)}</span>
      <div class="phone-who"><strong>${escapeHtml(participant.name)}</strong><small>${escapeHtml(subtitle)}</small></div>
      <span class="channel-chip">${onIMessage ? "iMessage" : "Spectrum · web"}</span>`;

    const key = `${participant.id}:${entries.length}`;
    if (key !== this.#renderedKey) {
      this.#renderedKey = key;
      this.#thread.innerHTML = entries.length
        ? entries.map(entry => this.#bubble(entry, snapshot.scenario.timeZone)).join("")
        : `<p class="thread-empty">No messages yet.</p>`;
      this.#scrollToEnd();
    }
    this.#typingRow.hidden = !this.#typing.has(participant.id);

    this.#input.disabled = onIMessage;
    this.#input.placeholder = onIMessage ? "Reply from the iMessage device" : `Message as ${participant.name.split(" ")[0]}`;
    this.#input.setAttribute("aria-label", `Message as ${participant.name}`);
    this.#form.querySelector("button")!.disabled = onIMessage;
    this.#note.hidden = !onIMessage;
    this.#note.textContent = onIMessage ? `${participant.name} is connected over iMessage via Photon. This view mirrors the conversation.` : "";
    const replies = onIMessage ? [] : this.#quickReplies(snapshot, participant);
    this.#quick.innerHTML = replies.map(reply =>
      `<button type="button" data-reply="${escapeHtml(reply)}">${escapeHtml(reply.length > 34 ? `${reply.slice(0, 32)}…` : reply)}</button>`).join("");
  }

  #bubble(entry: TranscriptEntry, timeZone: string): string {
    const fromAgent = entry.direction === "outbound";
    const urgent = /^(OFFICIAL WARNING|ROUTE UPDATE|ROUTE CHANGE|TRANSPORT REQUEST)/.test(entry.text);
    return `<article class="bubble ${fromAgent ? "bubble-agent" : "bubble-person"}${urgent ? " bubble-urgent" : ""}">
      ${fromAgent ? `<span class="bubble-from">God's Eye Evac</span>` : ""}
      <div class="bubble-text">${linkify(entry.text)}</div>
      <time>${clock(entry.at, timeZone)}</time>
    </article>`;
  }

  #quickReplies(snapshot: EvacSnapshot, participant: Participant): string[] {
    if (participant.role === "resident") {
      const household = snapshot.households.find(h => h.residentId === participant.id);
      switch (household?.stage) {
        case "warned": case "intake": return [DEMO_RESIDENT_MESSAGE];
        case "awaiting_consent": return ["Yes", "2", "No"];
        case "choosing_destination": return ["1", "2", "3"];
        case "self_evacuating": return ["Arrived", "STATUS"];
        case "awaiting_helper": case "arranged": return ["STATUS", "We also have a cat"];
        case "complete": return ["STATUS"];
        default: return ["HELP"];
      }
    }
    const helper = snapshot.helpers.find(h => h.participantId === participant.id);
    const arrangement = snapshot.arrangements.find(a => a.helperId === helper?.id && !["arrived", "cancelled", "unfilled"].includes(a.status));
    switch (arrangement?.status) {
      case "requested": return ["Accept", "Decline"];
      case "confirmed": case "en_route": return ["Picked up"];
      case "picked_up": return ["Arrived"];
      default: return [];
    }
  }

  async #submit(text: string): Promise<void> {
    const value = text.trim();
    if (!value || !this.#selectedId || this.#input.disabled) return;
    this.#input.value = "";
    try {
      await this.options.send(this.#selectedId, value);
    } catch (error) {
      this.#note.hidden = false;
      this.#note.textContent = error instanceof Error ? error.message : "Message failed";
    }
  }

  #scrollToEnd(): void {
    requestAnimationFrame(() => { this.#thread.scrollTop = this.#thread.scrollHeight; });
  }
}
