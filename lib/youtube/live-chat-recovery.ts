import { CHAT_ITEM_SELECTOR } from './adapter';
import { CHAT_DOM, findChatContainer } from './chat-dom';

export const LIVE_CHAT_HEALTH_INTERVAL_MS = 5_000;
export const LIVE_CHAT_STALL_MS = 60_000;
export const LIVE_CHAT_RECOVERY_COOLDOWN_MS = 5 * 60_000;
const ACTIVITY_WINDOW_MS = 60_000;
const MIN_ACTIVITY_SAMPLES = 6;
const MIN_ACTIVITY_SPAN_MS = 20_000;
const INTERACTION_GRACE_MS = 30_000;
const MODE_RESTORE_DELAY_MS = 1_500;

// No chat text or author data is needed to detect a break in recent activity.
// Silence alone cannot prove a failure; require sustained prior progress.
export class LiveChatStallTracker {
  private lastItemId: string | null = null;
  private lastProgressAt = 0;
  private progressTimes: number[] = [];
  private armed = false;
  private cooldownUntil = 0;

  reset() {
    this.lastItemId = null;
    this.lastProgressAt = 0;
    this.progressTimes = [];
    this.armed = false;
  }

  sample(now: number, lastItemId: string | null, canRecover: boolean): boolean {
    if (!canRecover || !lastItemId) {
      this.reset();
      return false;
    }
    if (lastItemId !== this.lastItemId) {
      const hadBaseline = this.lastItemId !== null;
      this.lastItemId = lastItemId;
      this.lastProgressAt = now;
      this.progressTimes = this.progressTimes.filter(
        (time) => now - time <= ACTIVITY_WINDOW_MS,
      );
      if (hadBaseline) this.progressTimes.push(now);
      this.progressTimes = this.progressTimes.slice(-MIN_ACTIVITY_SAMPLES);
      const first = this.progressTimes[0];
      this.armed =
        first !== undefined &&
        this.progressTimes.length >= MIN_ACTIVITY_SAMPLES &&
        now - first >= MIN_ACTIVITY_SPAN_MS;
      return false;
    }
    return (
      this.armed &&
      now - this.lastProgressAt >= LIVE_CHAT_STALL_MS &&
      now >= this.cooldownUntil
    );
  }

  attempted(now: number) {
    this.reset();
    this.cooldownUntil = now + LIVE_CHAT_RECOVERY_COOLDOWN_MS;
  }
}

function isVisible(element: HTMLElement): boolean {
  return (
    element.isConnected &&
    !element.closest('[hidden], [aria-hidden="true"]') &&
    element.getClientRects().length > 0
  );
}

function modeOptions(menu: HTMLElement): HTMLElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>(CHAT_DOM.modeOptions),
  ).filter((option) => option.querySelector(CHAT_DOM.modeReload));
}

function modeName(option: HTMLElement): string {
  return option.querySelector(CHAT_DOM.modeName)?.textContent?.trim() ?? '';
}

export function canRecoverLiveChat(doc: Document): boolean {
  const win = doc.defaultView;
  const scroller = doc.querySelector<HTMLElement>(CHAT_DOM.scroller);
  const menu = doc.querySelector<HTMLElement>(CHAT_DOM.modeMenu);
  const trigger = menu?.querySelector<HTMLElement>(CHAT_DOM.modeTrigger);
  if (
    !win ||
    win.location.pathname !== '/live_chat' ||
    !win.navigator.onLine ||
    doc.visibilityState !== 'visible' ||
    !scroller ||
    !menu ||
    !trigger ||
    !isVisible(scroller) ||
    !isVisible(trigger) ||
    scroller.clientHeight === 0 ||
    scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 8 ||
    trigger.getAttribute('aria-expanded') === 'true' ||
    trigger.getAttribute('aria-disabled') === 'true' ||
    trigger.hasAttribute('disabled')
  )
    return false;
  if (modeOptions(menu).length !== 2) return false;
  if (
    Array.from(doc.querySelectorAll<HTMLElement>(CHAT_DOM.openOverlay)).some(
      isVisible,
    )
  )
    return false;
  return !Array.from(doc.querySelectorAll<HTMLElement>(CHAT_DOM.input)).some(
    (input) =>
      input.contains(doc.activeElement) || Boolean(input.textContent?.trim()),
  );
}

export function startLiveChatRecovery(
  doc: Document,
  enabled: () => boolean,
): () => void {
  const win = doc.defaultView;
  if (!win || win.location.pathname !== '/live_chat') return () => undefined;
  const tracker = new LiveChatStallTracker();
  let previousList: WeakRef<HTMLElement> | undefined;
  let lastInteractionAt = Number.NEGATIVE_INFINITY;
  let interactionVersion = 0;
  let restoreTimer: number | undefined;
  const interaction = (event: Event) => {
    if (!event.isTrusted) return;
    lastInteractionAt = Date.now();
    interactionVersion += 1;
    tracker.reset();
  };
  const events = ['pointerdown', 'wheel', 'touchstart', 'keydown'] as const;
  for (const event of events) doc.addEventListener(event, interaction, true);

  const recover = (): boolean => {
    const menu = doc.querySelector<HTMLElement>(CHAT_DOM.modeMenu);
    const trigger = menu?.querySelector<HTMLElement>(CHAT_DOM.modeTrigger);
    if (!menu || !trigger) return false;
    const options = modeOptions(menu);
    const selected = options.find(
      (option) => option.getAttribute('aria-selected') === 'true',
    );
    const alternate = options.find((option) => option !== selected);
    if (!selected || !alternate) return false;
    const originalName = modeName(selected);
    const alternateName = modeName(alternate);
    if (!originalName || !alternateName || originalName === alternateName)
      return false;
    const version = interactionVersion;
    trigger.click();
    alternate.click();
    // Reacquire controls: YouTube may recreate the menu as well as the list.
    restoreTimer = win.setTimeout(() => {
      restoreTimer = undefined;
      if (version !== interactionVersion || doc.visibilityState !== 'visible')
        return;
      const currentMenu = doc.querySelector<HTMLElement>(CHAT_DOM.modeMenu);
      const currentTrigger = currentMenu?.querySelector<HTMLElement>(
        CHAT_DOM.modeTrigger,
      );
      if (
        !currentMenu ||
        !currentTrigger ||
        currentTrigger.getAttribute('aria-expanded') === 'true' ||
        Array.from(
          doc.querySelectorAll<HTMLElement>(CHAT_DOM.openOverlay),
        ).some(isVisible)
      )
        return;
      const currentOptions = modeOptions(currentMenu);
      const currentSelected = currentOptions.find(
        (option) => option.getAttribute('aria-selected') === 'true',
      );
      const original = currentOptions.find(
        (option) => modeName(option) === originalName,
      );
      if (
        !currentSelected ||
        modeName(currentSelected) !== alternateName ||
        !original
      )
        return;
      currentTrigger.click();
      original.click();
    }, MODE_RESTORE_DELAY_MS);
    return true;
  };

  const timer = win.setInterval(() => {
    const now = Date.now();
    const list = findChatContainer(doc);
    if (list !== previousList?.deref()) {
      tracker.reset();
      previousList = list ? new WeakRef(list) : undefined;
    }
    const last = list
      ? Array.from(list.children)
          .reverse()
          .find((item) => item.matches(CHAT_ITEM_SELECTOR))
      : undefined;
    const canRecover =
      enabled() &&
      restoreTimer === undefined &&
      now - lastInteractionAt >= INTERACTION_GRACE_MS &&
      canRecoverLiveChat(doc);
    if (tracker.sample(now, last?.id || null, canRecover) && recover()) {
      tracker.attempted(now);
    }
  }, LIVE_CHAT_HEALTH_INTERVAL_MS);

  return () => {
    win.clearInterval(timer);
    if (restoreTimer !== undefined) win.clearTimeout(restoreTimer);
    for (const event of events)
      doc.removeEventListener(event, interaction, true);
    tracker.reset();
  };
}
