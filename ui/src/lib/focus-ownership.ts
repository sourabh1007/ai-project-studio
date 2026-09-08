const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isDisabled(element: HTMLElement): boolean {
  return element.matches(':disabled');
}

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected) {
    return false;
  }
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (
      node.hasAttribute('hidden') ||
      node.hasAttribute('inert') ||
      node.getAttribute('aria-hidden') === 'true'
    ) {
      return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
  }
  return true;
}

function isFocusable(
  element: HTMLElement | null | undefined,
): element is HTMLElement {
  return !!element && !isDisabled(element) && isVisible(element);
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(isFocusable);
}

function previouslyFocusedElement(container: HTMLElement): HTMLElement | null {
  const active = captureActiveFocus();
  return active && !container.contains(active) ? active : null;
}

function restoreOwnedFocus(
  container: HTMLElement,
  previous: FocusTargetSnapshot | null,
): void {
  if (!previous || !isFocusable(previous.element)) {
    return;
  }
  if (!sameFocusOwnership(previous, previous.element)) {
    return;
  }
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    active !== document.body &&
    active !== document.documentElement &&
    !container.contains(active)
  ) {
    return;
  }
  previous.element.focus();
}

export function hasOpenModalDialog(doc: Document = document): boolean {
  return doc.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

export function captureActiveFocus(doc: Document = document): HTMLElement | null {
  const active = doc.activeElement;
  return active instanceof HTMLElement &&
      active !== doc.body &&
      active !== doc.documentElement
    ? active
    : null;
}

export interface FocusTargetSnapshot {
  element: HTMLElement;
  owner: string | null;
  token: string | null;
}

function focusOwnershipNode(element: HTMLElement): HTMLElement {
  return element.closest<HTMLElement>('[data-focus-owner]') ?? element;
}

function sameFocusOwnership(
  snapshot: FocusTargetSnapshot,
  current: HTMLElement,
): boolean {
  const source = focusOwnershipNode(current);
  if (snapshot.owner !== null && source.dataset.focusOwner !== snapshot.owner) {
    return false;
  }
  if (snapshot.token !== null && source.dataset.focusToken !== snapshot.token) {
    return false;
  }
  return true;
}

export function captureFocusTarget(
  doc: Document = document,
): FocusTargetSnapshot | null {
  const active = captureActiveFocus(doc);
  if (!active) {
    return null;
  }
  const source = focusOwnershipNode(active);
  return {
    element: active,
    owner: source.dataset.focusOwner ?? null,
    token: source.dataset.focusToken ?? null,
  };
}

export function attachDialogFocusOwnership(
  container: HTMLElement,
  options?: {
    initialFocus?: HTMLElement | null;
    restoreFocus?: FocusTargetSnapshot | null;
  },
): () => void {
  const previous =
    options?.restoreFocus ??
    (() => {
      const active = previouslyFocusedElement(container);
      return active ? captureFocusTarget(active.ownerDocument) : null;
    })();
  const initialFocus = options?.initialFocus;
  const activeWithin = captureActiveFocus();
  const target = isFocusable(initialFocus)
    ? initialFocus
    : activeWithin && container.contains(activeWithin) && isFocusable(activeWithin)
      ? activeWithin
    : focusableElements(container)[0] ?? container;
  if (document.activeElement !== target) {
    target.focus();
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') {
      return;
    }
    const focusables = focusableElements(container);
    if (focusables.length === 0) {
      event.preventDefault();
      container.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !container.contains(active)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', onKeyDown);
  return () => {
    container.removeEventListener('keydown', onKeyDown);
    restoreOwnedFocus(container, previous);
  };
}
