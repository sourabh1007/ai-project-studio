import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachDialogFocusOwnership,
  captureActiveFocus,
  captureFocusTarget,
  hasOpenModalDialog,
} from './focus-ownership.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('attachDialogFocusOwnership', () => {
  it('focuses the requested element and traps Tab inside the dialog', () => {
    document.body.innerHTML = `
      <button id="before">Before</button>
      <div id="dialog" role="dialog" aria-modal="true" tabindex="-1">
        <button id="first">First</button>
        <button id="last">Last</button>
      </div>
    `;

    const dialog = document.getElementById('dialog') as HTMLDivElement;
    const first = document.getElementById('first') as HTMLButtonElement;
    const last = document.getElementById('last') as HTMLButtonElement;

    const detach = attachDialogFocusOwnership(dialog, { initialFocus: last });
    expect(document.activeElement).toBe(last);

    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(first);

    first.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
    }));
    expect(document.activeElement).toBe(last);

    detach();
  });

  it('restores the prior focus only when it is still valid', () => {
    document.body.innerHTML = `
      <button id="before">Before</button>
      <button id="outside">Outside</button>
      <div id="dialog" role="dialog" aria-modal="true" tabindex="-1">
        <button id="inside">Inside</button>
      </div>
    `;

    const before = document.getElementById('before') as HTMLButtonElement;
    const outside = document.getElementById('outside') as HTMLButtonElement;
    const dialog = document.getElementById('dialog') as HTMLDivElement;
    const inside = document.getElementById('inside') as HTMLButtonElement;

    before.focus();
    const detach = attachDialogFocusOwnership(dialog);
    expect(document.activeElement).toBe(inside);

    detach();
    expect(document.activeElement).toBe(before);

    before.focus();
    const disconnecting = attachDialogFocusOwnership(dialog);
    before.remove();
    disconnecting();
    expect(document.activeElement).not.toBe(before);

    const disabledTarget = document.createElement('button');
    disabledTarget.textContent = 'Disabled';
    document.body.prepend(disabledTarget);
    disabledTarget.focus();
    const disabling = attachDialogFocusOwnership(dialog, {
      restoreFocus: captureFocusTarget(),
    });
    disabledTarget.disabled = true;
    disabling();
    expect(document.activeElement).not.toBe(disabledTarget);

    const hiddenTarget = document.createElement('button');
    hiddenTarget.textContent = 'Hidden';
    const wrapper = document.createElement('div');
    wrapper.append(hiddenTarget);
    document.body.prepend(wrapper);
    hiddenTarget.focus();
    const hiding = attachDialogFocusOwnership(dialog, {
      restoreFocus: captureFocusTarget(),
    });
    wrapper.hidden = true;
    hiding();
    expect(document.activeElement).not.toBe(hiddenTarget);

    const inertTarget = document.createElement('button');
    inertTarget.textContent = 'Inert';
    const inertWrapper = document.createElement('div');
    inertWrapper.append(inertTarget);
    document.body.prepend(inertWrapper);
    inertTarget.focus();
    const inerting = attachDialogFocusOwnership(dialog, {
      restoreFocus: captureFocusTarget(),
    });
    inertWrapper.setAttribute('inert', '');
    inerting();
    expect(document.activeElement).not.toBe(inertTarget);

    outside.focus();
    const respectingUserFocus = attachDialogFocusOwnership(dialog);
    outside.focus();
    respectingUserFocus();
    expect(document.activeElement).toBe(outside);
  });

  it('falls back to the container when nothing inside is focusable and leaves interior tabs alone', () => {
    document.body.innerHTML = `
      <div id="dialog" role="dialog" aria-modal="true" tabindex="-1">
        <div style="visibility:hidden"><button id="hidden">Hidden</button></div>
        <div inert><button id="inert">Inert</button></div>
        <button id="first">First</button>
        <button id="last">Last</button>
      </div>
    `;

    const dialog = document.getElementById('dialog') as HTMLDivElement;
    const hidden = document.getElementById('hidden') as HTMLButtonElement;
    const first = document.getElementById('first') as HTMLButtonElement;
    const last = document.getElementById('last') as HTMLButtonElement;

    const detach = attachDialogFocusOwnership(dialog, { initialFocus: hidden });
    expect(document.activeElement).toBe(first);

    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(first);

    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(first);

    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
    }));
    expect(document.activeElement).toBe(last);

    detach();

    const empty = document.createElement('div');
    empty.id = 'empty';
    empty.setAttribute('role', 'dialog');
    empty.setAttribute('aria-modal', 'true');
    empty.tabIndex = -1;
    empty.innerHTML = '<span>Read only</span>';
    document.body.append(empty);

    const detachEmpty = attachDialogFocusOwnership(empty);
    expect(document.activeElement).toBe(empty);

    empty.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(empty);

    detachEmpty();
  });

  it('does not restore focus when the previous active element was already inside the dialog', () => {
    document.body.innerHTML = `
      <div id="dialog" role="dialog" aria-modal="true" tabindex="-1">
        <button id="inside">Inside</button>
      </div>
    `;

    const dialog = document.getElementById('dialog') as HTMLDivElement;
    const inside = document.getElementById('inside') as HTMLButtonElement;
    inside.focus();

    const detach = attachDialogFocusOwnership(dialog, { initialFocus: inside });
    expect(document.activeElement).toBe(inside);

    detach();
    expect(document.activeElement).toBe(inside);
  });

  it('keeps an already-focused child inside the dialog and skips hidden-ancestor controls', () => {
    document.body.innerHTML = `
      <div id="dialog" role="dialog" aria-modal="true" tabindex="-1">
        <div style="visibility:hidden"><button id="hidden">Hidden</button></div>
        <button id="inside">Inside</button>
      </div>
    `;

    const dialog = document.getElementById('dialog') as HTMLDivElement;
    const inside = document.getElementById('inside') as HTMLButtonElement;
    inside.focus();

    const detach = attachDialogFocusOwnership(dialog);
    expect(document.activeElement).toBe(inside);

    detach();
  });

  it('does not restore a generation-bound target after its ownership token changes', () => {
    document.body.innerHTML = `
      <div data-focus-owner="terminal:s1" data-focus-token="1">
        <textarea id="terminal"></textarea>
      </div>
      <div id="dialog" role="dialog" aria-modal="true" tabindex="-1">
        <button id="inside">Inside</button>
      </div>
    `;

    const terminal = document.getElementById('terminal') as HTMLTextAreaElement;
    const dialog = document.getElementById('dialog') as HTMLDivElement;
    const owner = terminal.closest('[data-focus-owner]') as HTMLDivElement;

    terminal.focus();
    const snapshot = captureFocusTarget();
    const detach = attachDialogFocusOwnership(dialog, { restoreFocus: snapshot });
    owner.dataset.focusToken = '2';
    detach();

    expect(terminal).not.toHaveFocus();
  });

  it('does not restore a target after its focus owner changes', () => {
    document.body.innerHTML = `
      <div data-focus-owner="terminal:s1" data-focus-token="1">
        <textarea id="terminal"></textarea>
      </div>
      <div id="dialog" role="dialog" aria-modal="true" tabindex="-1">
        <button id="inside">Inside</button>
      </div>
    `;

    const terminal = document.getElementById('terminal') as HTMLTextAreaElement;
    const dialog = document.getElementById('dialog') as HTMLDivElement;
    const owner = terminal.closest('[data-focus-owner]') as HTMLDivElement;

    terminal.focus();
    const snapshot = captureFocusTarget();
    const detach = attachDialogFocusOwnership(dialog, { restoreFocus: snapshot });
    owner.dataset.focusOwner = 'terminal:s2';
    detach();

    expect(terminal).not.toHaveFocus();
  });

  it('honors fieldset disabled semantics, including the legend exception', () => {
    document.body.innerHTML = `
      <div id="dialog" role="dialog" aria-modal="true" tabindex="-1">
        <fieldset disabled>
          <legend>
            <button id="legend-button">Legend action</button>
          </legend>
          <button id="disabled-fieldset">Disabled fieldset button</button>
        </fieldset>
        <button id="enabled">Enabled</button>
      </div>
    `;

    const dialog = document.getElementById('dialog') as HTMLDivElement;
    const disabledFieldset = document.getElementById(
      'disabled-fieldset',
    ) as HTMLButtonElement;
    const legendButton = document.getElementById(
      'legend-button',
    ) as HTMLButtonElement;
    const enabled = document.getElementById('enabled') as HTMLButtonElement;

    const detach = attachDialogFocusOwnership(dialog, {
      initialFocus: disabledFieldset,
    });
    expect(document.activeElement).toBe(legendButton);
    enabled.focus();
    enabled.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    );
    expect(document.activeElement).toBe(legendButton);
    detach();
  });
});

describe('hasOpenModalDialog', () => {
  it('reports whether a modal dialog is currently mounted', () => {
    expect(hasOpenModalDialog()).toBe(false);
    render(<div role="dialog" aria-modal="true">Open</div>);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(hasOpenModalDialog()).toBe(true);
  });
});

describe('captureActiveFocus', () => {
  it('returns the current interactive element and ignores the document root', () => {
    expect(captureActiveFocus()).toBeNull();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    expect(captureActiveFocus()).toBe(input);
  });
});

describe('captureFocusTarget', () => {
  it('returns null when there is no current interactive target', () => {
    expect(captureFocusTarget()).toBeNull();
  });

  it('captures focus ownership metadata for generation-bound targets', () => {
    document.body.innerHTML = `
      <div data-focus-owner="terminal:s1" data-focus-token="4">
        <textarea id="terminal"></textarea>
      </div>
    `;
    const terminal = document.getElementById('terminal') as HTMLTextAreaElement;
    terminal.focus();

    expect(captureFocusTarget()).toEqual({
      element: terminal,
      owner: 'terminal:s1',
      token: '4',
    });
  });
});
