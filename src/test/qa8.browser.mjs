// Browser regressions shared by the collaborative Chromium preview and WebKit runner.
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const rect = element => {
  const r = element.getBoundingClientRect();
  return { x: r.x, y: r.y + scrollY, width: r.width, height: r.height };
};
export function observeShifts() {
  const supported = PerformanceObserver.supportedEntryTypes.includes('layout-shift');
  const shifts = [];
  const observer = supported ? new PerformanceObserver(list => {
    for (const entry of list.getEntries()) shifts.push({ value: entry.value, recentInput: entry.hadRecentInput });
  }) : null;
  observer?.observe({ type: 'layout-shift' });
  return () => {
    observer?.disconnect();
    return { supported, cls: supported ? shifts.filter(s => !s.recentInput).reduce((sum, s) => sum + s.value, 0) : null, shifts };
  };
}
export async function heroRegression() {
  await document.fonts.ready;
  const phone = innerWidth <= 760;
  const card = document.querySelector('.lp-card');
  const shot = document.querySelector('.lp-shot');
  const body = document.querySelector('.lp-shot__body');
  const buttons = [...document.querySelectorAll('.lp-run__who')];
  assert(card && buttons.length > 2, 'Hero has selectable authors');
  assert(!/\bexample\b/i.test(document.body.innerText), 'Landing copy never says example');
  assert(![...document.querySelectorAll('[aria-label],[title],[alt]')].some(e => /\bexample\b/i.test(['aria-label', 'title', 'alt'].map(a => e.getAttribute(a)).join(' '))), 'Accessible landing copy never says example');
  const calls = [];
  const original = card.scrollIntoView;
  card.scrollIntoView = function(options) { calls.push(options); return original.call(this, options); };
  try {
    window.scrollTo(0, rect(card).y - 900);
    body.scrollTop = body.scrollHeight;
    await wait(650);
    const visible = buttons.filter(b => { const r = b.getBoundingClientRect(); return r.top >= body.getBoundingClientRect().top && r.bottom <= Math.min(innerHeight, body.getBoundingClientRect().bottom); });
    const button = phone ? visible.at(-1) : buttons.at(-1);
    assert(button, 'Lowest visible author is available');
    const before = { card: rect(card), shot: rect(shot), pageHeight: document.documentElement.scrollHeight, scrollY };
    const finish = observeShifts();
    button.click();
    await wait(1100);
    const after = { card: rect(card), shot: rect(shot), pageHeight: document.documentElement.scrollHeight, scrollY };
    assert(button.getAttribute('aria-pressed') === 'true', 'Tapped author is selected');
    if (phone) assert(JSON.stringify(before.card) === JSON.stringify(after.card), 'Card layout is unchanged');
    assert(JSON.stringify(before.shot) === JSON.stringify(after.shot), 'Hero layout is unchanged');
    assert(before.pageHeight === after.pageHeight, 'Page height is unchanged');
    if (phone) {
      assert(card.getBoundingClientRect().bottom <= innerHeight + 1 && card.getBoundingClientRect().top >= 0, 'Card scrolls fully into view');
      assert(calls.length === 1 && calls[0].block === 'nearest', 'Only one nearest scroll');
      assert(calls[0].behavior === (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'), 'Reduced motion is respected');
      button.click();
      await wait(650);
      assert(calls.length === 1, 'Visible card does not scroll again');
    } else {
      assert(calls.length === 0 && before.scrollY === after.scrollY, 'Desktop selection does not scroll');
    }
    const layout = finish();
    if (phone && layout.supported) assert(layout.cls === 0 && layout.shifts.length === 0, 'Hero selection has zero layout shift, including recent input');
    return { viewport: [innerWidth, innerHeight], author: button.textContent, before, after, calls, layout };
  } finally { card.scrollIntoView = original; }
}

export function branchesRegression() {
  const sections = [...document.querySelectorAll('.branches__section')];
  const main = sections.find(s => s.getAttribute('aria-label') === 'Default branch');
  const other = sections.find(s => s.getAttribute('aria-label') === 'Other branches');
  assert(main && other, 'Both branch groups exist');
  assert(!main.querySelector('a[aria-label^="Compare "]'), 'Default branch has no Compare link');
  assert(other.querySelectorAll('a[aria-label^="Compare "]').length === other.querySelectorAll('.branches__row').length, 'Every other branch has Compare');
  const slots = [...document.querySelectorAll('.branches__compare-slot')].map(rect);
  assert(slots.every(s => s.width === slots[0].width && s.height === slots[0].height), 'Compare slots retain equal geometry');
  return { slots, compares: [...document.querySelectorAll('a[aria-label^="Compare "]')].map(a => a.getAttribute('href')) };
}

export async function mergedTimeRegression() {
  const line = [...document.querySelectorAll('.task-next__line')].find(e => e.textContent.includes('Merged into'));
  assert(line && line.querySelector('time'), 'Task has merged');
  line.scrollIntoView({ block: 'center', behavior: 'instant' });
  await document.fonts.ready;
  const time = line.querySelector('time');
  const realNow = Date.now;
  const timestamp = Date.parse(time.dateTime);
  const geometry = () => ({ line: rect(line), hash: rect(line.querySelector('.mono')), next: rect(line.parentElement.nextElementSibling ?? line.parentElement), time: { ...rect(time), width: undefined } });
  try {
    Date.now = () => timestamp;
    await wait(15_500);
    assert(time.textContent === 'just now', 'Actual React clock renders just now');
    assert(getComputedStyle(time).minWidth === '0px', 'No time width reservation');
    assert(getComputedStyle(time).fontVariantNumeric === 'tabular-nums', 'Time uses tabular numbers');
    const before = geometry();
    const beforeText = line.innerText;
    const focused = document.activeElement;
    const finish = observeShifts();
    Date.now = () => timestamp + 60_000;
    await wait(15_500);
    assert(time.textContent === '1m ago', 'Actual React clock renders 1m ago');
    const after = geometry();
    assert(JSON.stringify(before) === JSON.stringify(after), 'Time update leaves text origins and surrounding geometry unchanged');
    assert(document.activeElement === focused, 'Time update preserves focus');
    const layout = finish();
    if (layout.supported) assert(layout.cls === 0 && layout.shifts.length === 0, 'Time update has zero layout shift');
    return { beforeText, afterText: line.innerText, before, after, layout, focusPreserved: true, focusable: line.tabIndex === -1 };
  } finally { Date.now = realNow; }
}
