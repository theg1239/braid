/** Browser regression: run in a signed-in dashboard tab at 390 × 844 via preview_evaluate. */
export async function assertDashboardPhone() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  assert(innerWidth === 390 && innerHeight === 844, 'Use the QA phone viewport: 390 × 844.');
  const rows = [...document.querySelectorAll('.dash .pr[data-status]')];
  assert(rows.length > 0, 'The fixture must contain pull requests.');
  assert(document.querySelector('.dash__section--merged .pr'), 'The fixture must contain recent activity.');
  let assertions = 3;
  for (const row of rows) {
    row.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const main = row.querySelector('.pr__main');
    assert(main?.checkVisibility({ contentVisibilityAuto: true, checkVisibilityCSS: true, checkOpacity: true }), 'A phone row must render its main content.');
    assert(main.getBoundingClientRect().width >= 140, 'A phone row must reserve width for its text.');
    for (const selector of ['.pr__title', '.pr__repo', '.pr__num', '.dash__author', '.dash__state']) {
      const node = main.querySelector(selector);
      assert(node?.textContent.trim() && node.checkVisibility({ contentVisibilityAuto: true, checkVisibilityCSS: true, checkOpacity: true }), `${selector} must be present and visible on a phone.`);
    }
    const when = row.querySelector('time');
    assert(when?.textContent.trim() && when.getBoundingClientRect().left >= main.getBoundingClientRect().left, 'The time must sit under the text, not in the icon column.');
    const bounds = main.getBoundingClientRect();
    assert(bounds.left >= 0 && bounds.right <= innerWidth, 'Row text must stay inside the viewport.');
    assertions += 9;
  }
  assert(document.documentElement.scrollWidth === innerWidth, 'The phone page must not scroll horizontally.');
  window.scrollTo(0, 0);
  return { rows: rows.length, assertions: assertions + 1, viewport: `${innerWidth}×${innerHeight}` };
}
