# Visual Bug Fixes — YouPlanner

> **For agentic workers:** Implement tasks sequentially in `index.html`.

**Goal:** Fix 3 visual bugs on iPhone — sheet under tab-bar, button styles, keyboard input overlap.

**Architecture:** Three independent CSS/JS patches to `index.html`:
1. Raise `#level-sheet` z-index to 1200
2. Apply soft TickTick-style to `.qaza-start-option.is-cursor` and `#qaza-done`
3. Add scrollIntoView + padding on input focus in sheets

**Tech Stack:** Vanilla HTML/CSS/JS (no frameworks)

**Spec:** Bug report from user (3 bugs).

## Global Constraints
- All changes in single file: `C:\Users\Admin\Desktop\youplanner-new\index.html`
- Do not break existing JS logic or CSS specificity chains
- Preserve all existing z-index hierarchy relationships

## Review Focus
1. Level-sheet z-index must be higher than tab-bar's 1000
2. Button styles must match TickTick soft style, not solid blue
3. Input focus must scroll the field above keyboard without breaking sheet layout

---

### Task 1: Raise #level-sheet z-index above tab-bar

**Files:**
- Modify: `index.html` lines 1435-1436

**Interfaces:**
- Consumes: tab-bar z-index 1000 (line 2801, 2921)
- Produces: level-sheet z-index 1200 (above 1000)

- [ ] **Step 1: Change `#level-sheet` z-index from 120 to 1200**

  Find line 1435-1436:
  ```css
  #level-sheet {
    z-index: 120;
  }
  ```
  Replace with:
  ```css
  #level-sheet {
    z-index: 1200;
  }
  ```

- [ ] **Step 2: Verify backdrop also covers tab-bar**

  The `.sheet-backdrop` is inside `#level-sheet`, so with z-index 1200 it covers everything. Check that `.sheet-backdrop` has `position: absolute; inset: 0;` (already at line 1390-1394). No change needed — backdrop inherits the parent's stacking context.

### Task 2: Soft TickTick-style for qaza buttons

**Files:**
- Modify: `index.html` around line 947

**Interfaces:**
- Consumes: existing `.qaza-start-option.is-cursor` rule at line 947
- Produces: soft background, accent color text, subtle border

- [ ] **Step 1: Replace `.qaza-start-option.is-cursor` background style**

  Current (lines 947-951):
  ```css
  .qaza-start-option.is-cursor,
  .qaza-add-option.is-picked {
    border-color: var(--accent);
    background-color: var(--accent-soft);
  }
  ```
  Already has soft background. Add explicit color to ensure text is accent blue:
  ```css
  .qaza-start-option.is-cursor {
    background: rgba(88, 112, 197, 0.12);
    color: #5870C5;
    border: 1px solid rgba(88, 112, 197, 0.3);
  }
  ```

- [ ] **Step 2: Style `#qaza-done` with soft TickTick style**

  Current `#qaza-done` uses `class="btn btn-primary"` (line 9399), giving it solid blue accent background.
  Add CSS rule to override the primary button style when it's the qaza-done button:
  ```css
  #qaza-done {
    background: rgba(88, 112, 197, 0.12);
    color: #5870C5;
    border: 1px solid rgba(88, 112, 197, 0.3);
  }
  ```

### Task 3: Scroll input above keyboard on focus in sheets

**Files:**
- Modify: `index.html` — add JS event handler near line 7305
- Modify: `index.html` — add CSS rule for focused sheet input

- [ ] **Step 1: Add focusin handler for sheet inputs**

  After the visualViewport listeners (around line 7305), add:
  ```js
  // Поднимать поле ввода над клавиатурой при фокусе внутри шторок
  document.addEventListener('focusin', function(e) {
    const input = e.target;
    if (!input || !input.matches) return;
    const sheetPanel = input.closest('.sheet-panel');
    if (!sheetPanel) return;
    // Небольшая задержка чтобы клавиатура успела появиться
    requestAnimationFrame(function() {
      input.scrollIntoView({ block: 'nearest' });
      sheetPanel.style.paddingBottom = '40px';
    });
  });
  ```

- [ ] **Step 2: Add focusout handler to restore padding**

  ```js
  document.addEventListener('focusout', function(e) {
    const input = e.target;
    if (!input || !input.matches) return;
    const sheetPanel = input.closest('.sheet-panel');
    if (!sheetPanel) return;
    sheetPanel.style.paddingBottom = '';
  });
  ```
